(function (SIM) {
  'use strict';

  const B = {};

  SIM.build = function (canvas) {
    B.bus = new SIM.CAN.CANBus();
    B.veh = new SIM.Vehicle();

    B.ecm = new SIM.ECU.ECM(B.bus, B.veh);
    B.eps = new SIM.ECU.EPS(B.bus, B.veh);
    B.abs = new SIM.ECU.ABS(B.bus, B.veh);
    B.bcm = new SIM.ECU.BCM(B.bus, B.veh);
    B.plant = new SIM.ECU.PLANT(B.bus, B.veh);
    B.gw = new SIM.ECU.Gateway(B.bus);
    [B.ecm, B.eps, B.abs, B.bcm, B.plant, B.gw].forEach(function (e) { B.bus.attach(e); });

    B.rke = new SIM.RKE.RKESystem(B.bcm);
    B.tel = new SIM.Telematics(B.gw);

    B.input = { steer: 0, throttle: 0, brake: 0, gear: 0 };

    SIM.Scene.init(canvas);
    SIM.B = B;
    wireKeyboard();
    startLoop();
    SIM.emit('sys', 'Rig online. Car is LOCKED and OFF. Try the attack chain →');
  };

  // What a hijacker forces: throttle pinned, D held.
  const MALICIOUS = { steer_tgt: 12, throttle_tgt: 100, brake_tgt: 0, gear_req: 3 };

  // The authorised rig sends the driver's input through the gateway; an armed
  // attacker also splices its own DRIVE_CMD onto the bus. Whether the ECUs obey
  // it depends entirely on their filtering.
  function sendDrive() {
    B.gw.request('drive', {
      steer_tgt: B.input.steer, throttle_tgt: B.input.throttle,
      brake_tgt: B.input.brake, gear_req: B.input.gear,
    }, B.gw.sessionKey);

    if (SIM.security.canInjection) {
      const c = (sendDrive._c = ((sendDrive._c || 0) + 1) & 0x0f);
      const f = SIM.CAN.encode('DRIVE_CMD', MALICIOUS, c);
      f.src = 'ATTACKER';        // no gateway, no credentials
      B.bus.send(f);
    }
  }

  // ---- fixed-step sim at 50 Hz, render on rAF --------------------------------
  function startLoop() {
    let last = performance.now(), acc = 0, driveAcc = 0;
    const STEP = 0.02;
    function frame(t) {
      let dt = (t - last) / 1000; last = t;
      if (dt > 0.1) dt = 0.1;
      acc += dt;
      while (acc >= STEP) {
        driveAcc += STEP;
        if (driveAcc >= 0.02) { driveAcc = 0; sendDrive(); }
        B.ecm.update(STEP); B.eps.update(STEP); B.abs.update(STEP);
        B.bcm.update(STEP); B.plant.update(STEP);
        B.bus.deliver();
        B.veh.update(STEP);
        SIM.state.ignition = B.bcm.ignition && B.ecm.state !== 0;
        acc -= STEP;
      }
      SIM.Scene.update(B.veh, Math.min(dt, 0.05));
      if (SIM.UI) SIM.UI.refresh(B);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function wireKeyboard() {
    const keys = {};
    window.addEventListener('keydown', function (e) { keys[e.key.toLowerCase()] = true; });
    window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
    setInterval(function () {
      const up = keys['w'] || keys['arrowup'], down = keys['s'] || keys['arrowdown'];
      const left = keys['a'] || keys['arrowleft'], right = keys['d'] || keys['arrowright'];
      B.input.throttle = up ? 80 : 0;
      B.input.brake = down ? 70 : 0;
      const tgt = (left ? -B.veh.maxSteer : 0) + (right ? B.veh.maxSteer : 0);
      B.input.steer += (tgt - B.input.steer) * 0.25;
    }, 20);
  }

  // ---- API for the UI buttons ------------------------------------------------
  SIM.api = {
    fobUnlock:  function () { B.rke.press('unlock'); },
    fobLock:    function () { B.rke.press('lock'); },
    replay:     function () { B.rke.replayLast(); },
    relay:      function () { B.rke.relayLive(); },
    jammer:     function (on) { B.rke.setJammer(on); },
    setDB:      function (on) { B.rke.db.enabled = on;
                                SIM.emit('rke', on ? 'Distance bounding ON (τ=' + B.rke.db.tauNs + 'ns) — relays beyond the RTT ceiling are rejected' : 'Distance bounding OFF'); },
    setTau:     function (ns) { B.rke.db.tauNs = ns; },
    telStart:   function () { B.tel.ownerRemoteStart(); },
    telUnlock:  function () { B.tel.ownerUnlock(); },
    attackTel:  function () { B.tel.attackerRemoteStart(); },
    startEngine:function () { B.ecm.crank(); B.bcm.ignition = true; },
    stopEngine: function () { B.ecm.stop(); B.bcm.ignition = false; },
    setGear:    function (g) { B.input.gear = g; },
    setAuth:    function (on) { B.gw.authRequired = on; },
    setSecoc:   function (on) { SIM.security.secoc = on; SIM.SecOC.reset();
                                SIM.emit('gw', on ? 'SecOC ON — ECUs verify MAC + freshness on commands' : 'SecOC OFF — bus accepts any command frame'); },
    setInject:  function (on) { SIM.security.canInjection = on;
                                SIM.emit('gw', on ? 'ATTACK: attacker injecting unsigned DRIVE_CMD onto the bus' : 'Attacker injection stopped'); },
    resetPose:  function () { B.veh.x = B.veh.z = B.veh.heading = B.veh.speed = 0; SIM.SecOC.reset(); },
    follow:     function (on) { SIM.Scene.setFollow(on); },
    get:        function () { return B; },
  };
})(window.SIM = window.SIM || {});
