// Measures every security claim over many trials, headlessly, with the same
// code the browser runs.  node test/evidence.js
// Writes evidence/report.json and evidence/RESULTS.md.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

['js/crypto.js','js/distancebound.js','js/core.js','js/can.js','js/ecu.js','js/rke.js','js/telematics.js','js/vehicle.js']
  .forEach(f => require(path.join(root, f)));
const SIM = globalThis.SIM;
SIM.emit = function () {};   // silence the human log during measurement

const R = {};

// ---- 0. crypto correctness -------------------------------------------------
R.crypto = SIM.Crypto.selfTest();

// ---- helpers ---------------------------------------------------------------
function stubBcm() { return { locked: true, unlock() { this.locked = false; }, lock() { this.locked = true; } }; }

function buildRig() {
  SIM.SecOC.reset();
  const bus = new SIM.CAN.CANBus(), veh = new SIM.Vehicle();
  const rig = {
    bus, veh,
    ecm: new SIM.ECU.ECM(bus, veh), eps: new SIM.ECU.EPS(bus, veh),
    abs: new SIM.ECU.ABS(bus, veh), bcm: new SIM.ECU.BCM(bus, veh),
    plant: new SIM.ECU.PLANT(bus, veh), gw: new SIM.ECU.Gateway(bus),
  };
  [rig.ecm, rig.eps, rig.abs, rig.bcm, rig.plant, rig.gw].forEach(e => bus.attach(e));
  return rig;
}
function step(rig, input, injState) {
  const S = 0.02;
  rig.gw.request('drive', { steer_tgt: input.steer||0, throttle_tgt: input.throttle||0,
                            brake_tgt: input.brake||0, gear_req: input.gear||0 }, rig.gw.sessionKey);
  if (injState) {
    const f = SIM.CAN.encode('DRIVE_CMD', { steer_tgt: 12, throttle_tgt: 100, brake_tgt: 0, gear_req: 3 },
                             (injState.c = ((injState.c||0)+1) & 0x0f));
    f.src = 'ATTACKER';                    // deliberately unsigned
    rig.bus.send(f);
  }
  rig.ecm.update(S); rig.eps.update(S); rig.abs.update(S);
  rig.bcm.update(S); rig.plant.update(S);
  rig.bus.deliver(); rig.veh.update(S);
}
const dist = v => Math.hypot(v.x, v.z);
const sendRaw = (rig, f) => { rig.bus.send(f); rig.bus.deliver(); return f.authOK === true; };

// ---- 1. RKE replay rejected, legitimate presses accepted --------------------
(function () {
  const N = 1000, sys = new SIM.RKE.RKESystem(stubBcm());
  let legit = 0, replays = 0;
  for (let i = 0; i < N; i++) {
    if (sys.press('unlock')) legit++;
    if (sys.replayLast()) replays++;
  }
  R.rke_replay = { trials: N, legit_accepted: legit, replays_accepted: replays,
                   pass: legit === N && replays === 0 };
})();

// ---- 2. relay of a live code succeeds --------------------------------------
(function () {
  const N = 1000, sys = new SIM.RKE.RKESystem(stubBcm());
  let ok = 0;
  for (let i = 0; i < N; i++) if (sys.relayLive()) ok++;
  R.rke_relay = { trials: N, relayed_accepted: ok, pass: ok === N };
})();

// ---- 3. RollJam: jam and capture, then replay the unheard code -------------
(function () {
  const N = 1000; let ok = 0;
  for (let i = 0; i < N; i++) {
    const bcm = stubBcm(), sys = new SIM.RKE.RKESystem(bcm);
    sys.setJammer(true); sys.press('unlock');   // captured; the car never heard it
    sys.setJammer(false); sys.replayLast();      // replay it
    if (bcm.locked === false) ok++;
  }
  R.rke_rolljam = { trials: N, unlocked: ok, pass: ok === N };
})();

// ---- 4. MAC forgery: keyless checksum vs keyed HMAC ------------------------
// The attacker knows the algorithm, not the key.
(function () {
  const serial = 0x1234, bits = 32;
  const weak = new SIM.RKE.RKESystem(stubBcm(), 'weak', bits);
  const forged = { serial, action: 'unlock', counter: 1,
                   mac: SIM.RKE.computeTag('weak', null, serial, 1, 'unlock', bits) };
  const weakForged = weak.rx.receive(forged, 'forge');
  const hmac = new SIM.RKE.RKESystem(stubBcm(), 'hmac', bits);
  const guesses = 500000; let hit = 0;
  for (let i = 0; i < guesses; i++) {
    const g = (Math.random() * 0x100000000 >>> 0).toString(16).padStart(8, '0');
    if (hmac.rx.receive({ serial, action: 'unlock', counter: 1, mac: g })) { hit++; break; }
  }
  R.mac_forgery = {
    weak_keyless: { attempts_to_forge: 1, forged: weakForged },
    hmac_keyed:   { guesses: guesses, forged_count: hit,
                    expected_attempts_5050: Math.pow(2, bits - 1) },
    pass: weakForged === true && hit === 0,
  };
})();

// ---- 5. CAN injection: SecOC on blocks it, off lets it drive ---------------
function injectionRun(secoc) {
  SIM.security.secoc = secoc;
  const rig = buildRig();
  rig.ecm.crank(); rig.bcm.ignition = true;
  const inj = { c: 0 };
  for (let i = 0; i < 150; i++) step(rig, { throttle: 0 }, inj);  // driver idle, attacker floors it
  return { moved_m: +dist(rig.veh).toFixed(2), speed_kph: +rig.veh.speed.toFixed(1), gear: rig.veh.gearName() };
}
(function () {
  const on = injectionRun(true), off = injectionRun(false);
  SIM.security.secoc = true;
  R.can_injection = { secoc_on: on, secoc_off: off,
                      pass: on.moved_m < 0.5 && off.moved_m > 5 };
})();

// ---- 6. replay of a validly signed command, rejected by freshness ----------
(function () {
  SIM.security.secoc = true;
  const rig = buildRig();
  const key = SIM.security.busKey;
  const f0 = SIM.CAN.encode('DRIVE_CMD', { throttle_tgt: 80, gear_req: 3, steer_tgt: 0, brake_tgt: 0 }, 1);
  f0.src = 'GATEWAY'; SIM.SecOC.sign(f0, key);
  const firstAccepted = sendRaw(rig, f0);
  let replayAccepted = 0, N = 100;
  for (let i = 0; i < N; i++) {
    const copy = { id: f0.id, name: f0.name, data: f0.data.slice(), dlc: 8, ts: 0, src: 'ATTACKER', fv: f0.fv, mac: f0.mac };
    if (sendRaw(rig, copy)) replayAccepted++;
  }
  R.can_replay = { first_accepted: firstAccepted, replays: N, replays_accepted: replayAccepted,
                   pass: firstAccepted === true && replayAccepted === 0 };
})();

// ---- 7. telematics: owner forwarded, attacker blocked ----------------------
(function () {
  const rig = buildRig(); rig.gw.authRequired = true;
  const owner = rig.gw.request('start', null, rig.gw.sessionKey);
  const attacker = rig.gw.request('start', null, 0x00);
  R.telematics = { owner_forwarded: owner, attacker_blocked: attacker === false,
                   blocked_count: rig.gw.blocked, pass: owner === true && attacker === false };
})();

// ---- 8. distance bounding vs relay: tau swept, seeded ----------------------
function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000; }
function gauss(rand) { const u1 = Math.max(1e-12, rand()), u2 = rand(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); }
function poisson(lam, rand) { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= rand(); } while (p > L); return k - 1; }

(function () {
  const DB = SIM.DistanceBounding;
  const N = 300000, budget = 0.001, relayLatency = 20, attackerDist = 15, legitLo = 0.3, legitHi = 2.0;
  const sigmas = [0.7, 2, 5, 15, 30, 60];             // 0.7 ns ~ real UWB (~10 cm)
  const rand = lcg(0x1234abcd);
  const rows = sigmas.map(sig => {
    const honest = new Float64Array(N), relay = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      honest[i] = DB.rttExcessNs(legitLo + (legitHi - legitLo) * rand()) + gauss(rand) * sig;
      relay[i]  = DB.rttExcessNs(attackerDist) + relayLatency + gauss(rand) * sig;
    }
    honest.sort();
    // The tightest tau an honest owner tolerates, then the relay success left.
    const tau = honest[Math.min(N - 1, Math.ceil((1 - budget) * N) - 1)];
    let relayOK = 0, frr = 0;
    for (let i = 0; i < N; i++) { if (relay[i] <= tau) relayOK++; if (honest[i] > tau) frr++; }
    return { sigma_ns: sig, ranging_accuracy_m: +(DB.C * sig / 2).toFixed(2), best_tau_ns: +tau.toFixed(1),
             relay_success_pct: +(100 * relayOK / N).toFixed(2), honest_false_reject_pct: +(100 * frr / N).toFixed(2) };
  });
  R.distance_bounding = {
    trials_per_sigma: N, false_reject_budget_pct: budget * 100, attacker_distance_m: attackerDist,
    relay_latency_ns: relayLatency, legit_distance_m: [legitLo, legitHi], rows,
    pass: rows[0].relay_success_pct < 1 && rows[rows.length - 1].relay_success_pct > rows[0].relay_success_pct + 10,
  };
})();

// ---- 9. rolling-code resync window ------------------------------------------
// B, the presses the car never saw, is Poisson(lambda) with lambda swept. The
// owner is locked out iff B >= W; a replay of one sniffed code at offset
// K in 1..B is accepted iff K <= W. Both move oppositely with W.
(function () {
  const N = 300000, lambdas = [0.5, 1, 2, 4], windows = [1, 2, 4, 8, 16, 32, 64, 256];
  const rand = lcg(0x51de5eed);
  const byLambda = lambdas.map(lam => {
    const B = new Int32Array(N), K = new Int32Array(N);
    for (let i = 0; i < N; i++) { B[i] = poisson(lam, rand); K[i] = B[i] >= 1 ? 1 + Math.floor(rand() * B[i]) : 0; }
    const rows = windows.map(W => {
      let lock = 0, atk = 0;
      for (let i = 0; i < N; i++) { if (B[i] >= W) lock++; if (B[i] >= 1 && K[i] <= W) atk++; }
      return { window: W, lockout_pct: +(100 * lock / N).toFixed(2), capture_replay_pct: +(100 * atk / N).toFixed(2) };
    });
    return { lambda: lam, rows };
  });
  const main = byLambda.find(x => x.lambda === 2).rows;
  R.counter_window = {
    trials: N, lambdas, by_lambda: byLambda,
    note: 'B = out-of-range presses ~ Poisson(λ); attacker sniffs one unused code at random offset K∈1..B',
    pass: main[0].lockout_pct > main[main.length - 1].lockout_pct &&
          main[0].capture_replay_pct < main[main.length - 1].capture_replay_pct,
  };
})();

// ---- report ----------------------------------------------------------------
// property: must hold (UPHELD/BROKEN). vuln: reproduced weakness. tradeoff:
// swept curve. Kept apart so "attack works" never reads as "secure".
const properties = [
  ['Crypto correct (FIPS-180-4 + RFC 4231 vectors)', R.crypto.pass],
  ['Rolling code rejects replay, accepts legit',      R.rke_replay.pass],
  ['Keyed HMAC resists forgery (keyless does not)',   R.mac_forgery.pass],
  ['SecOC blocks CAN command injection',              R.can_injection.pass],
  ['SecOC freshness blocks signed-frame replay',      R.can_replay.pass],
  ['Gateway auth: owner ok, attacker blocked',        R.telematics.pass],
  ['Distance bounding decisive at UWB-class precision', R.distance_bounding.pass],
];
const vulns = [
  ['Relay of a live code unlocks (no distance bounding)', R.rke_relay.pass],
  ['RollJam (jam+capture+replay) unlocks',                R.rke_rolljam.pass],
];
const tradeoffs = [
  ['Distance-bounding precision→τ design sweep (σ swept)',        R.distance_bounding.pass],
  ['Rolling-code window: lockout vs capture-replay (λ swept)',    R.counter_window.pass],
];
const allOk = properties.every(c => c[1]) && vulns.every(c => c[1]) && tradeoffs.every(c => c[1]);
R.meta = { generatedAt: new Date().toISOString(), node: process.version, allOk };

fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(root, 'evidence', 'report.json'), JSON.stringify(R, null, 2));

const D = R.distance_bounding, CW = R.counter_window;
const md = [
  '# Evidence — measured results',
  '',
  '_Generated by `node test/evidence.js` on ' + R.meta.generatedAt + ' (Node ' + R.meta.node + ')._',
  '',
  'Verdicts are split on purpose: a reproduced **vulnerability** is the model',
  'being faithful, not the system being secure.',
  '',
  '## Security properties (must hold)',
  '',
  '| Property | Verdict |',
  '|---|---|',
  ...properties.map(c => '| ' + c[0] + ' | ' + (c[1] ? '✅ UPHELD' : '❌ BROKEN') + ' |'),
  '',
  '## Vulnerabilities reproduced (expected to succeed)',
  '',
  '| Known weakness | Verdict |',
  '|---|---|',
  ...vulns.map(c => '| ' + c[0] + ' | ' + (c[1] ? '⚠️ REPRODUCED' : '❔ not reproduced') + ' |'),
  '',
  '## Numbers behind the verdicts',
  '',
  '- **Rolling code:** ' + R.rke_replay.legit_accepted + '/' + R.rke_replay.trials +
    ' legitimate presses accepted; ' + R.rke_replay.replays_accepted + '/' + R.rke_replay.trials + ' replays accepted.',
  '- **Relay (no defence):** ' + R.rke_relay.relayed_accepted + '/' + R.rke_relay.trials +
    ' live-relayed codes accepted — rolling codes cannot stop relay.',
  '- **RollJam:** ' + R.rke_rolljam.unlocked + '/' + R.rke_rolljam.trials + ' jam-and-replay attempts unlocked the car.',
  '- **MAC forgery:** keyless checksum forged in **' + R.mac_forgery.weak_keyless.attempts_to_forge +
    '** attempt (no key). Keyed HMAC: **' + R.mac_forgery.hmac_keyed.forged_count + '** forgeries in ' +
    R.mac_forgery.hmac_keyed.guesses.toLocaleString() + ' guesses (expected work ≈ 2³¹).',
  '- **CAN injection:** SecOC ON → car moved ' + R.can_injection.secoc_on.moved_m + ' m (gear ' +
    R.can_injection.secoc_on.gear + '). SecOC OFF → car moved ' + R.can_injection.secoc_off.moved_m +
    ' m to ' + R.can_injection.secoc_off.speed_kph + ' kph (gear ' + R.can_injection.secoc_off.gear + ').',
  '- **Signed-command replay:** first frame accepted; ' + R.can_replay.replays_accepted + '/' +
    R.can_replay.replays + ' replays of that exact signed frame accepted (freshness counter).',
  '- **Telematics:** owner forwarded=' + R.telematics.owner_forwarded + ', attacker blocked=' + R.telematics.attacker_blocked + '.',
  '',
  '## Design sweep — how much timing precision must distance bounding buy?',
  '',
  'The τ threshold is not a free knob: it is bounded below by how noisy your',
  'ranging is. For each timing jitter **σ**, we pick the *tightest* τ an honest',
  'owner tolerates (false-reject ≤ ' + D.false_reject_budget_pct + '%) and measure the relay success that',
  'σ leaves on the table. Attacker relays from ' + D.attacker_distance_m + ' m (+' + D.relay_latency_ns +
    ' ns hardware latency); honest fob at ' + D.legit_distance_m[0] + '–' + D.legit_distance_m[1] +
    ' m; ' + D.trials_per_sigma.toLocaleString() + ' trials per σ.',
  '',
  '| σ (ns) | ≈ ranging accuracy | tightest τ | relay success | honest false-reject |',
  '|---:|---:|---:|---:|---:|',
  ...D.rows.map(r => '| ' + r.sigma_ns + ' | ' + r.ranging_accuracy_m + ' m | ' + r.best_tau_ns +
    ' ns | ' + r.relay_success_pct + '% | ' + r.honest_false_reject_pct + '% |'),
  '',
  '_Honest false-reject is held at the budget in every row — the free variable is',
  'residual **relay success**. At UWB precision (σ≈0.7 ns, ~10 cm) the relay is',
  'crushed to ' + D.rows[0].relay_success_pct + '% with no honest cost; as ranging degrades past ~2 m the far',
  'relay hides in the timing noise (σ=30 ns → ' + (D.rows.find(r=>r.sigma_ns===30)||{}).relay_success_pct +
    '%, σ=60 ns → ' + (D.rows.find(r=>r.sigma_ns===60)||{}).relay_success_pct + '%). So distance bounding is not a',
  'fragile compromise — it is **decisive if and only if you buy UWB-class timing**,',
  'which is exactly why the CCC Digital Key standard uses UWB. This table is a',
  'procurement spec, not a single configuration._',
  '',
  '## Tradeoff curve — rolling-code resync window (λ swept)',
  '',
  CW.note + '. ' + CW.trials.toLocaleString() + ' trials per point. Table shown for λ=2; ' +
    'full λ∈{' + CW.lambdas.join(', ') + '} sweep is in `report.json`.',
  '',
  '| window W | honest lockout | attacker capture-replay |',
  '|---:|---:|---:|',
  ...CW.by_lambda.find(x => x.lambda === 2).rows.map(r => '| ' + r.window + ' | ' + r.lockout_pct + '% | ' + r.capture_replay_pct + '% |'),
  '',
  '_Both columns are measured and move oppositely with W: a narrow window shrinks',
  'the odds a sniffed unused code still lies inside it (capture-replay) but',
  'desyncs honest users who pressed out of range (lockout). Widening W trades one',
  'for the other. λ-sensitivity (honest lockout at W=4): ' +
    CW.by_lambda.map(x => 'λ=' + x.lambda + '→' + x.rows.find(r => r.window === 4).lockout_pct + '%').join(', ') + '._',
  '',
].join('\n');
fs.writeFileSync(path.join(root, 'evidence', 'RESULTS.md'), md);

function line(label, ok, word) { console.log((ok ? word[0] : word[1]).padEnd(12) + label); }
console.log('\nRKE RIG — EVIDENCE HARNESS');
console.log('='.repeat(60));
console.log('PROPERTIES (must hold)');
properties.forEach(c => line('  ' + c[0], c[1], ['UPHELD', 'BROKEN']));
console.log('VULNERABILITIES (reproduced on purpose)');
vulns.forEach(c => line('  ' + c[0], c[1], ['REPRODUCED', 'MISSING']));
console.log('TRADEOFF CURVES (monotonic)');
tradeoffs.forEach(c => line('  ' + c[0], c[1], ['CURVE', 'FLAT']));
console.log('='.repeat(60));
console.log('distance bounding: relay success ' + R.distance_bounding.rows[0].relay_success_pct + '% @ σ=0.7ns (UWB)  →  ' +
            R.distance_bounding.rows[R.distance_bounding.rows.length-1].relay_success_pct + '% @ σ=60ns');
console.log(allOk ? 'MODEL BEHAVED AS SPECIFIED' : 'UNEXPECTED RESULT');
console.log('Wrote evidence/report.json and evidence/RESULTS.md');
process.exit(allOk ? 0 : 1);
