(function (SIM) {
  'use strict';

  function Vehicle() {
    this.throttle = 0;      // %
    this.brake = 0;         // %
    this.steerAngle = 0;    // deg at the road wheel (already geared down)
    this.gear = 0;          // 0 P, 1 R, 2 N, 3 D
    this.engineOn = false;
    this.doorsLocked = true;

    this.x = 0; this.z = 0; // world position (metres)
    this.heading = 0;       // radians, 0 = +x
    this.speed = 0;         // kph (signed: negative in reverse)

    this.wheelbase = 2.84;  // m (Sonata-ish)
    this.wheelR = 0.34;     // m
    this.finalDrive = 3.5;
    this.maxSteer = 35;     // deg road-wheel lock
    this.mass = 1500;       // kg
  }

  Vehicle.prototype.update = function (dt) {
    const gearName = SIM.CAN.GEARS[this.gear];
    const v = this.speed / 3.6;                 // m/s

    let accel = 0;
    if (this.engineOn && (gearName === 'D' || gearName === 'R')) {
      const drive = this.throttle / 100 * 4.0;  // m/s^2 at full throttle
      accel += (gearName === 'R') ? -drive : drive;
    }
    // Brake always opposes motion; parking gear pins the car.
    const brakeA = this.brake / 100 * 8.0;
    if (gearName === 'P') { this.speed = 0; }
    accel -= Math.sign(v) * Math.min(Math.abs(v) / dt, brakeA + 0.4 /*rolling drag*/);

    let newV = v + accel * dt;
    if (this.throttle < 1 && Math.abs(newV) < 0.15 && this.brake > 0) newV = 0; // creep clamp
    this.speed = newV * 3.6;

    // Kinematic bicycle model.
    const steerRad = this.steerAngle * Math.PI / 180;
    if (Math.abs(newV) > 0.05) {
      const yawRate = newV / this.wheelbase * Math.tan(steerRad);
      this.heading += yawRate * dt;
    }
    this.x += newV * Math.cos(this.heading) * dt;
    this.z += newV * Math.sin(this.heading) * dt;
  };

  Vehicle.prototype.gearName = function () { return SIM.CAN.GEARS[this.gear]; };

  SIM.Vehicle = Vehicle;
})(globalThis.SIM = globalThis.SIM || {});
