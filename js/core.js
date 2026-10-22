(function (SIM) {
  'use strict';
  SIM.now = function () { return performance.now(); };

  SIM._subs = {};
  SIM.on = function (chan, fn) { (SIM._subs[chan] = SIM._subs[chan] || []).push(fn); };
  SIM.events = [];
  SIM.emit = function (chan, msg) {
    const e = { chan: chan, msg: msg, t: SIM.now() };
    SIM.events.push(e);
    if (SIM.events.length > 300) SIM.events.shift();
    (SIM._subs[chan] || []).forEach(function (fn) { fn(e); });
    (SIM._subs['*'] || []).forEach(function (fn) { fn(e); });
  };

  SIM.state = { ignition: false };

  // Trust is cryptographic, not a src label. busKey is the shared SecOC key
  // held by the gateway and the ECUs.
  SIM.security = {
    secoc: true,
    busKey: new Uint8Array([0x53,0x65,0x63,0x4f,0x43,0x21,0x9a,0x2f,
                            0xc1,0x04,0xbe,0xef,0x77,0x10,0x33,0xd8]),
  };
})(globalThis.SIM = globalThis.SIM || {});
