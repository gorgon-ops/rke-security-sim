(function (SIM) {
  'use strict';

  const S = {};

  function makeCar() {
    const car = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: 0x2e6fdb, metalness: 0.6, roughness: 0.35 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x101820, metalness: 0.4, roughness: 0.1 });
    const tire  = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.7, 1.85), paint);
    body.position.y = 0.6; body.castShadow = true; car.add(body);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.55, 1.7), glass);
    hood.position.set(-0.2, 1.1, 0); car.add(hood);

    // A spin group (axle) inside a steer group (yaw).
    S.wheels = [];
    const positions = [[1.4, -0.75], [1.4, 0.75], [-1.4, -0.75], [-1.4, 0.75]];
    positions.forEach(function (p, i) {
      const steer = new THREE.Group();
      steer.position.set(p[0], 0.34, p[1]);
      const spin = new THREE.Group();
      const geo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 20);
      geo.rotateX(Math.PI / 2);
      const w = new THREE.Mesh(geo, tire); w.castShadow = true;
      spin.add(w); steer.add(spin); car.add(steer);
      S.wheels.push({ steer: steer, spin: spin, front: p[0] > 0 });
    });

    S.brakeMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0x330000 });
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.25, 1.6), S.brakeMat);
    tl.position.set(-2.35, 0.7, 0); car.add(tl);
    S.headMat = new THREE.MeshStandardMaterial({ color: 0x222200, emissive: 0x000000 });
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 1.6), S.headMat);
    hl.position.set(2.35, 0.7, 0); car.add(hl);

    return car;
  }

  S.init = function (canvas) {
    S.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    S.renderer.setPixelRatio(window.devicePixelRatio);
    S.renderer.shadowMap.enabled = true;
    S.scene = new THREE.Scene();
    S.scene.background = new THREE.Color(0x0a0e14);
    S.scene.fog = new THREE.Fog(0x0a0e14, 60, 260);

    S.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
    S.camera.position.set(-9, 6, 9);
    S.controls = new THREE.OrbitControls(S.camera, canvas);
    S.controls.enableDamping = true;
    S.follow = true;

    S.scene.add(new THREE.HemisphereLight(0x8899bb, 0x223344, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(30, 50, 20); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
    S.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.MeshStandardMaterial({ color: 0x12161d, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    S.scene.add(ground);
    const grid = new THREE.GridHelper(600, 120, 0x2a3550, 0x1a2030);
    S.scene.add(grid);

    S.car = makeCar();
    S.scene.add(S.car);

    window.addEventListener('resize', S.resize);
    S.resize();
  };

  S.resize = function () {
    const c = S.renderer.domElement;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w || c.height !== h) S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
  };

  S.update = function (veh, dt) {
    S.resize();
    S.car.position.set(veh.x, 0, veh.z);
    S.car.rotation.y = -veh.heading;
    const spin = (veh.speed / 3.6) / veh.wheelR * dt;
    const steerRad = -veh.steerAngle * Math.PI / 180;
    S.wheels.forEach(function (wh) {
      wh.spin.rotation.x += spin;
      if (wh.front) wh.steer.rotation.y = steerRad;
    });
    const b = veh.brake / 100;
    S.brakeMat.emissive.setRGB(0.2 + b * 0.8, 0, 0);
    S.headMat.emissive.setRGB(0, 0, 0);
    if (SIM.state && SIM.state.ignition) S.headMat.emissive.setRGB(0.9, 0.9, 0.7);

    if (S.follow) {
      const back = new THREE.Vector3(Math.cos(veh.heading), 0, Math.sin(veh.heading));
      const tgt = new THREE.Vector3(veh.x, 1, veh.z);
      const want = tgt.clone().add(back.multiplyScalar(-11)).add(new THREE.Vector3(0, 5, 0));
      S.camera.position.lerp(want, Math.min(1, dt * 2.5));
      S.controls.target.lerp(tgt, Math.min(1, dt * 4));
    }
    S.controls.update();
    S.renderer.render(S.scene, S.camera);
  };

  S.setFollow = function (on) { S.follow = on; };

  SIM.Scene = S;
})(window.SIM = window.SIM || {});
