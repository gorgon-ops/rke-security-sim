// A relayed rolling code is a genuine fresh code, so the only defence is
// measuring distance by round-trip time. A threshold tau on the round trip
// caps relay distance at c * tau / 2, about 0.15 m per ns - what UWB distance
// bounding does in CCC Digital Key.
(function (SIM) {
  'use strict';
  const C = 0.299792458;                       // speed of light, m/ns (one-way)

  const rttExcessNs = d => (2 * d) / C;        // round-trip propagation for distance d (m)
  const maxRelayDistanceM = tau => (C * tau) / 2;

  // sc: { distance_m, relay?, relayLatencyNs?, jitterSigmaNs? }; rand: () -> [0,1)
  function measure(sc, rand) {
    rand = rand || Math.random;
    let t = rttExcessNs(sc.distance_m || 0);
    if (sc.relay) t += (sc.relayLatencyNs || 0);   // real relay hardware adds delay a close fob does not
    if (sc.jitterSigmaNs) {                          // Box-Muller
      const u1 = Math.max(1e-12, rand()), u2 = rand();
      t += Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sc.jitterSigmaNs;
    }
    return t < 0 ? 0 : t;
  }

  const accept = (measuredNs, tauNs) => measuredNs <= tauNs;

  SIM.DistanceBounding = { C, rttExcessNs, maxRelayDistanceM, measure, accept };
})(globalThis.SIM = globalThis.SIM || {});
