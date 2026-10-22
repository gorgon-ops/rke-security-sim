// The car accepts a press only if the MAC verifies and the counter is newer
// than the last it saw. That rejects replay of an old capture, but not a relay
// of a live press or a RollJam replay - both are genuine fresh codes.
(function (SIM) {
  'use strict';
  const C = SIM.Crypto;
  const ACT = { unlock: 1, lock: 2 };

  function macMsg(serial, counter, action) {
    return C.concat(C.concat(C.u32le(serial), C.u32le(counter)),
                    new Uint8Array([ACT[action] || 0]));
  }
  // 'weak' is a keyless checksum, kept only so the evidence can forge it.
  function computeTag(scheme, key, serial, counter, action, bits) {
    const msg = macMsg(serial, counter, action);
    return scheme === 'weak' ? C.weakTag(msg, bits) : C.tag(key, msg, bits);
  }

  // ---- the fob ---------------------------------------------------------------
  function Fob(serial, key, scheme, bits) {
    this.serial = serial; this.key = key; this.counter = 1;
    this.scheme = scheme || 'hmac'; this.bits = bits || 32;
  }
  Fob.prototype.buildPacket = function (action) {
    const c = this.counter++;
    return { serial: this.serial, action: action, counter: c,
             mac: computeTag(this.scheme, this.key, this.serial, c, action, this.bits) };
  };

  // ---- the receiver inside the BCM ------------------------------------------
  function RKEReceiver(bcm, serial, key, scheme, bits) {
    this.bcm = bcm; this.serial = serial; this.key = key;
    this.scheme = scheme || 'hmac'; this.bits = bits || 32;
    this.last = 0; this.window = 256;
  }
  RKEReceiver.prototype.receive = function (p, tag) {
    tag = tag ? ' [' + tag + ']' : '';
    if (p.serial !== this.serial) { SIM.emit('rke', 'REJECT' + tag + ': unknown fob serial'); return false; }
    if (p.mac !== computeTag(this.scheme, this.key, p.serial, p.counter, p.action, this.bits)) {
      SIM.emit('rke', 'REJECT' + tag + ': bad MAC (forgery blocked)'); return false;
    }
    if (p.counter <= this.last) { SIM.emit('rke', 'REJECT' + tag + ': stale counter (' + p.counter + ' <= ' + this.last + ') — replay blocked'); return false; }
    if (p.counter > this.last + this.window) { SIM.emit('rke', 'REJECT' + tag + ': counter outside resync window'); return false; }
    this.last = p.counter;
    if (p.action === 'unlock') this.bcm.unlock();
    else if (p.action === 'lock') this.bcm.lock();
    SIM.emit('rke', 'ACCEPT' + tag + ': ' + p.action + ' (counter ' + p.counter + ')');
    return true;
  };

  // ---- the RF channel, where an attacker with an SDR sits --------------------
  function RFChannel(receiver) {
    this.receiver = receiver;
    this.jammed = false;
    this.captures = [];        // what an eavesdropper grabbed off the air
  }
  RFChannel.prototype.transmit = function (packet, tag) {
    this.captures.push(Object.assign({}, packet));
    if (this.jammed) { SIM.emit('rke', 'RF JAMMED — car did not receive ' + packet.action + ' (attacker captured it)'); return false; }
    return this.receiver.receive(packet, tag);
  };

  // ---- facade ----------------------------------------------------------------
  function RKESystem(bcm, scheme, bits) {
    const serial = 0x1234;
    const key = C.strBytes('fob-shared-secret-01');
    this.fob = new Fob(serial, key, scheme, bits);
    this.rx = new RKEReceiver(bcm, serial, key, scheme, bits);
    this.ch = new RFChannel(this.rx);
    // Off by default so the relay attack can be shown, then defeated.
    this.db = { enabled: false, tauNs: 100, jitterSigmaNs: 0.7,  // 0.7 ns ~ real UWB (~10 cm)
                legitDistanceM: 1.0, relayDistanceM: 15, relayLatencyNs: 20 };
  }
  RKESystem.prototype._rangeOk = function (relay) {
    if (!this.db.enabled) return true;
    const DB = SIM.DistanceBounding;
    const m = DB.measure({
      distance_m: relay ? this.db.relayDistanceM : this.db.legitDistanceM,
      relay: relay, relayLatencyNs: this.db.relayLatencyNs, jitterSigmaNs: this.db.jitterSigmaNs,
    });
    const ok = DB.accept(m, this.db.tauNs);
    if (!ok) SIM.emit('rke', 'DISTANCE-BOUNDING: rejected — RTT ' + m.toFixed(0) + 'ns > τ ' +
                             this.db.tauNs + 'ns (≈' + DB.maxRelayDistanceM(this.db.tauNs).toFixed(1) + 'm ceiling)');
    return ok;
  };
  RKESystem.prototype.press = function (action) {
    SIM.emit('rke', 'Fob press: ' + action);
    if (!this._rangeOk(false)) return false;
    return this.ch.transmit(this.fob.buildPacket(action));
  };
  RKESystem.prototype.replayLast = function () {
    if (!this.ch.captures.length) { SIM.emit('rke', 'Nothing captured to replay yet'); return false; }
    const cap = this.ch.captures[this.ch.captures.length - 1];
    SIM.emit('rke', 'Attacker replays captured packet (counter ' + cap.counter + ')');
    return this.ch.transmit(Object.assign({}, cap), 'replay');
  };
  RKESystem.prototype.relayLive = function () {
    SIM.emit('rke', 'Attacker relay: forwarding a LIVE fob signal to the car');
    if (!this._rangeOk(true)) return false;   // distance bounding sees the relay's added delay
    return this.ch.transmit(this.fob.buildPacket('unlock'), 'relay');
  };
  RKESystem.prototype.setJammer = function (on) {
    this.ch.jammed = on;
    SIM.emit('rke', on ? 'Jammer ON — RollJam: capture presses, car stays locked' : 'Jammer OFF');
  };

  SIM.RKE = { Fob, RKEReceiver, RFChannel, RKESystem, computeTag, macMsg, ACT };
})(globalThis.SIM = globalThis.SIM || {});
