(function (SIM) {
  'use strict';

  // ---- signal packing (little-endian / Intel layout) -----------------------
  function setBits(bytes, startBit, length, raw) {
    raw = raw >>> 0;
    for (let i = 0; i < length; i++) {
      const bitIndex = startBit + i;
      const byteIndex = bitIndex >> 3;
      const bitInByte = bitIndex & 7;
      if ((raw >> i) & 1) bytes[byteIndex] |= (1 << bitInByte);
      else bytes[byteIndex] &= ~(1 << bitInByte);
    }
  }
  function getBits(bytes, startBit, length) {
    let val = 0;
    for (let i = 0; i < length; i++) {
      const bitIndex = startBit + i;
      const byteIndex = bitIndex >> 3;
      const bitInByte = bitIndex & 7;
      const bit = (bytes[byteIndex] >> bitInByte) & 1;
      val |= (bit << i);
    }
    return val >>> 0;
  }

  // Additive checksum over data + id, Hyundai/GM style.
  function computeChecksum(id, bytes) {
    let s = (id & 0xff) + ((id >> 8) & 0xff);
    for (let i = 0; i < 7; i++) s += bytes[i]; // byte 7 reserved for checksum
    return s & 0xff;
  }

  // ---- the DBC ---------------------------------------------------------------
  // start = LSB position in the 64-bit payload. hasCC = rolling counter in
  // byte 6 high nibble + checksum in byte 7.
  const DB = {
    ECM_STATUS:  { id: 0x0C0, period: 20,  hasCC: true,  signals: {
      engine_state: { start: 0,  len: 2,  scale: 1,    offset: 0 },     // 0 off,1 crank,2 run
      rpm:          { start: 8,  len: 16, scale: 0.25, offset: 0 },
      throttle:     { start: 24, len: 8,  scale: 0.5,  offset: 0 },     // %
    }},
    EPS_STATUS:  { id: 0x0D0, period: 20,  hasCC: true,  signals: {
      steer_angle:  { start: 0,  len: 16, scale: 0.1,  offset: -800 },  // deg (-800..800)
    }},
    ABS_STATUS:  { id: 0x0E0, period: 20,  hasCC: true,  signals: {
      brake_press:  { start: 0,  len: 8,  scale: 0.5,  offset: 0 },     // %
    }},
    WHEEL_SPEED: { id: 0x110, period: 20,  hasCC: true,  signals: {
      speed:        { start: 0,  len: 16, scale: 0.05, offset: 0 },     // kph
    }},
    GEAR_STATUS: { id: 0x120, period: 100, hasCC: false, signals: {
      gear:         { start: 0,  len: 3,  scale: 1,    offset: 0 },     // 0 P,1 R,2 N,3 D
    }},
    BCM_STATUS:  { id: 0x1A0, period: 100, hasCC: false, signals: {
      doors_locked: { start: 0,  len: 1,  scale: 1,    offset: 0 },
      ignition_on:  { start: 1,  len: 1,  scale: 1,    offset: 0 },
      alarm_armed:  { start: 2,  len: 1,  scale: 1,    offset: 0 },
    }},
    // Into the vehicle, emitted by the gateway after authentication.
    REMOTE_CMD:  { id: 0x200, period: 0,   hasCC: false, signals: {
      req_unlock:   { start: 0,  len: 1,  scale: 1,    offset: 0 },
      req_lock:     { start: 1,  len: 1,  scale: 1,    offset: 0 },
      req_start:    { start: 2,  len: 1,  scale: 1,    offset: 0 },
    }},
    DRIVE_CMD:   { id: 0x300, period: 20,  hasCC: true,  signals: {
      steer_tgt:    { start: 0,  len: 16, scale: 0.1,  offset: -800 },  // deg
      throttle_tgt: { start: 16, len: 8,  scale: 0.5,  offset: 0 },     // %
      brake_tgt:    { start: 24, len: 8,  scale: 0.5,  offset: 0 },     // %
      gear_req:     { start: 32, len: 3,  scale: 1,    offset: 0 },
    }},
  };
  const NAME_BY_ID = {};
  Object.keys(DB).forEach(function (n) { DB[n].id_name = n; NAME_BY_ID[DB[n].id] = n; });

  function encode(msgName, values, counter) {
    const def = DB[msgName];
    const bytes = new Uint8Array(8);
    Object.keys(def.signals).forEach(function (sig) {
      const s = def.signals[sig];
      let phys = values[sig] != null ? values[sig] : 0;
      let raw = Math.round((phys - s.offset) / s.scale);
      const max = (1 << s.len) - 1;
      if (raw < 0) raw = 0; if (raw > max) raw = max;
      setBits(bytes, s.start, s.len, raw);
    });
    if (def.hasCC) {
      bytes[6] = (bytes[6] & 0x0f) | (((counter || 0) & 0x0f) << 4);
      bytes[7] = computeChecksum(def.id, bytes);
    }
    return { id: def.id, name: msgName, data: bytes, dlc: 8, ts: SIM.now() };
  }

  function decode(frame) {
    const name = frame.name || NAME_BY_ID[frame.id];
    const def = DB[name];
    if (!def) return null;
    const out = {};
    Object.keys(def.signals).forEach(function (sig) {
      const s = def.signals[sig];
      out[sig] = getBits(frame.data, s.start, s.len) * s.scale + s.offset;
    });
    if (def.hasCC) {
      out._counter = (frame.data[6] >> 4) & 0x0f;
      out._checksum = frame.data[7];
      out._checksum_ok = frame.data[7] === computeChecksum(def.id, frame.data);
    }
    return out;
  }

  // ---- the bus ---------------------------------------------------------------
  // Every node hears every frame, delivered in ascending id order each tick to
  // mimic arbitration.
  function CANBus() {
    this.nodes = [];          // objects with .onFrame(frame, decoded)
    this.pending = [];        // frames queued this tick
    this.log = [];            // ring buffer for the monitor
    this.maxLog = 400;
    this.stats = { frames: 0, byId: {} };
    this.injectHook = null;   // attack module can rewrite/drop frames
  }
  CANBus.prototype.attach = function (node) { this.nodes.push(node); };
  CANBus.prototype.send = function (frame) { this.pending.push(frame); };

  CANBus.prototype.deliver = function () {
    if (!this.pending.length) return;
    this.pending.sort(function (a, b) { return a.id - b.id; });
    const frames = this.pending;
    this.pending = [];
    const COMMANDS = { 0x200: 1, 0x300: 1 };  // REMOTE_CMD, DRIVE_CMD
    for (let i = 0; i < frames.length; i++) {
      let frame = frames[i];
      if (this.injectHook) { frame = this.injectHook(frame); if (!frame) continue; }
      // Verified once here, so every ECU shares the verdict and the freshness
      // counter advances a single time.
      if (COMMANDS[frame.id]) {
        frame.authOK = (SIM.security && SIM.security.secoc)
          ? SIM.SecOC.verify(frame, SIM.security.busKey)
          : true;
      }
      const decoded = decode(frame);
      this.stats.frames++;
      this.stats.byId[frame.id] = (this.stats.byId[frame.id] || 0) + 1;
      this.log.push({ id: frame.id, name: frame.name, data: frame.data.slice(),
                      decoded: decoded, ts: frame.ts, src: frame.src });
      if (this.log.length > this.maxLog) this.log.shift();
      for (let n = 0; n < this.nodes.length; n++) this.nodes[n].onFrame(frame, decoded);
    }
  };

  SIM.CAN = { DB: DB, NAME_BY_ID: NAME_BY_ID, encode: encode, decode: decode,
              CANBus: CANBus, computeChecksum: computeChecksum,
              GEARS: ['P', 'R', 'N', 'D'], ENGINE: ['OFF', 'CRANK', 'RUN'] };
})(globalThis.SIM = globalThis.SIM || {});
