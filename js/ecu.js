// GATEWAY is the security boundary between the outside world and the bus: it
// decides whether a remote command may move wheels.
(function (SIM) {
  'use strict';
  const CAN = SIM.CAN;

  // authOK is stamped by the bus (valid MAC + fresh counter). src is only a
  // display tag; trust is the cryptography.
  function trusted(frame) { return frame.authOK !== false; }

  // ---- base ------------------------------------------------------------------
  function ECU(name, bus) { this.name = name; this.bus = bus; this._ctr = {}; this._acc = {}; }
  ECU.prototype.tx = function (msg, values) {
    const c = (this._ctr[msg] = ((this._ctr[msg] || 0) + 1) & 0x0f);
    const f = CAN.encode(msg, values, c);
    f.src = this.name;
    this.bus.send(f);
  };
  ECU.prototype.tick = function (msg, dt, fn) {
    const period = CAN.DB[msg].period;
    this._acc[msg] = (this._acc[msg] || 0) + dt * 1000;
    if (this._acc[msg] >= period) { this._acc[msg] = 0; this.tx(msg, fn()); }
  };
  ECU.prototype.onFrame = function () {};
  ECU.prototype.update = function () {};

  // ---- ECM: engine -----------------------------------------------------------
  function ECM(bus, veh) {
    ECU.call(this, 'ECM', bus); this.veh = veh;
    this.state = 0; this.rpm = 0; this.throttleCmd = 0; this.crankT = 0;
  }
  ECM.prototype = Object.create(ECU.prototype);
  ECM.prototype.onFrame = function (frame, d) {
    if (frame.name === 'REMOTE_CMD' && d.req_start) this.crank();
    if (frame.name === 'DRIVE_CMD' && d._checksum_ok !== false && trusted(frame)) {
      this.throttleCmd = d.throttle_tgt;
    }
  };
  ECM.prototype.crank = function () {
    if (this.state === 2) return;
    this.state = 1; this.crankT = 0.9;    // ~900 ms of cranking
  };
  ECM.prototype.stop = function () { this.state = 0; this.rpm = 0; this.throttleCmd = 0; };
  ECM.prototype.update = function (dt) {
    if (this.state === 1) {
      this.rpm += (280 - this.rpm) * Math.min(1, dt * 6);
      this.crankT -= dt;
      if (this.crankT <= 0) this.state = 2;
    } else if (this.state === 2) {
      const wheelRpm = this.veh.speed / 3.6 / (2 * Math.PI * this.veh.wheelR) * 60 * this.veh.finalDrive;
      const target = 800 + this.throttleCmd / 100 * 5200 + Math.min(2500, wheelRpm);
      this.rpm += (target - this.rpm) * Math.min(1, dt * 4);
    } else {
      this.rpm += (0 - this.rpm) * Math.min(1, dt * 8);
    }
    this.veh.engineOn = this.state === 2;
    this.veh.throttle = this.state === 2 ? this.throttleCmd : 0;
    this.tick('ECM_STATUS', dt, () => ({ engine_state: this.state, rpm: this.rpm, throttle: this.throttleCmd }));
  };

  // ---- EPS: steering ---------------------------------------------------------
  function EPS(bus, veh) { ECU.call(this, 'EPS', bus); this.veh = veh; this.target = 0; }
  EPS.prototype = Object.create(ECU.prototype);
  EPS.prototype.onFrame = function (frame, d) {
    if (frame.name === 'DRIVE_CMD' && d._checksum_ok !== false && trusted(frame)) this.target = d.steer_tgt;
  };
  EPS.prototype.update = function (dt) {
    const rate = 400 * dt;                              // deg/s actuation limit
    const diff = this.target - this.veh.steerAngle;
    this.veh.steerAngle += Math.max(-rate, Math.min(rate, diff));
    this.tick('EPS_STATUS', dt, () => ({ steer_angle: this.veh.steerAngle }));
  };

  // ---- ABS: brakes -----------------------------------------------------------
  function ABS(bus, veh) { ECU.call(this, 'ABS', bus); this.veh = veh; this.cmd = 0; }
  ABS.prototype = Object.create(ECU.prototype);
  ABS.prototype.onFrame = function (frame, d) {
    if (frame.name === 'DRIVE_CMD' && d._checksum_ok !== false && trusted(frame)) this.cmd = d.brake_tgt;
  };
  ABS.prototype.update = function (dt) {
    this.veh.brake = this.cmd;
    this.tick('ABS_STATUS', dt, () => ({ brake_press: this.cmd }));
  };

  // ---- BCM: doors, ignition, alarm -------------------------------------------
  function BCM(bus, veh) {
    ECU.call(this, 'BCM', bus); this.veh = veh;
    this.locked = true; this.ignition = false; this.alarm = true;
  }
  BCM.prototype = Object.create(ECU.prototype);
  BCM.prototype.onFrame = function (frame, d) {
    if (frame.name === 'REMOTE_CMD') {
      if (d.req_unlock) this.unlock();
      if (d.req_lock) this.lock();
      if (d.req_start) this.ignition = true;
    }
  };
  BCM.prototype.unlock = function () { this.locked = false; this.alarm = false; SIM.emit('bcm', 'Doors UNLOCKED'); };
  BCM.prototype.lock   = function () { this.locked = true;  this.alarm = true;  SIM.emit('bcm', 'Doors LOCKED'); };
  BCM.prototype.update = function (dt) {
    this.veh.doorsLocked = this.locked;
    this.tick('BCM_STATUS', dt, () => ({
      doors_locked: this.locked ? 1 : 0,
      ignition_on:  this.ignition ? 1 : 0,
      alarm_armed:  this.alarm ? 1 : 0,
    }));
  };

  // ---- wheel speed and gear --------------------------------------------------
  function PLANT(bus, veh) { ECU.call(this, 'PLANT', bus); this.veh = veh; }
  PLANT.prototype = Object.create(ECU.prototype);
  PLANT.prototype.onFrame = function (frame, d) {
    if (frame.name === 'DRIVE_CMD' && d._checksum_ok !== false && trusted(frame)) this.veh.gear = d.gear_req | 0;
  };
  PLANT.prototype.update = function (dt) {
    this.tick('WHEEL_SPEED', dt, () => ({ speed: Math.abs(this.veh.speed) }));
    this.tick('GEAR_STATUS', dt, () => ({ gear: this.veh.gear }));
  };

  // ---- GATEWAY ---------------------------------------------------------------
  // With auth off, anything is forwarded - that is the point of the demo.
  function Gateway(bus) {
    ECU.call(this, 'GATEWAY', bus);
    this.authRequired = true;
    // OAuth-style bearer secret, not a guessable PIN.
    this.sessionKey = 'a3f5c1e0-9b74-4d2a-8e11-6f0c72d9b4aa';
    this.blocked = 0; this.forwarded = 0;
  }
  Gateway.prototype = Object.create(ECU.prototype);
  Gateway.prototype.txSigned = function (msg, values) {
    const c = (this._ctr[msg] = ((this._ctr[msg] || 0) + 1) & 0x0f);
    const f = CAN.encode(msg, values, c); f.src = 'GATEWAY';
    if (SIM.security && SIM.security.secoc) SIM.SecOC.sign(f, SIM.security.busKey);
    this.bus.send(f);
  };
  Gateway.prototype.request = function (kind, payload, token) {
    if (this.authRequired && token !== this.sessionKey) {
      this.blocked++;
      SIM.emit('gw', 'BLOCKED unauthenticated ' + kind + ' request');
      return false;
    }
    this.forwarded++;
    if (kind === 'unlock') this.txSigned('REMOTE_CMD', { req_unlock: 1 });
    else if (kind === 'lock') this.txSigned('REMOTE_CMD', { req_lock: 1 });
    else if (kind === 'start') this.txSigned('REMOTE_CMD', { req_start: 1 });
    else if (kind === 'drive') this.txSigned('DRIVE_CMD', payload);
    return true;
  };

  SIM.ECU = { ECU, ECM, EPS, ABS, BCM, PLANT, Gateway };
})(globalThis.SIM = globalThis.SIM || {});
