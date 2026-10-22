# RKE Rig — Remote Start & Drive Simulator

A self-contained model of the full chain that lets someone wake up a car,
unlock it, start it, and drive it — **your own version**, built from scratch. It
reproduces the real protocol flow (RF rolling codes authenticated with
**HMAC-SHA-256**, a CAN bus with proper frame framing, **SecOC** message
authentication, drive-by-wire ECUs, a telematics/cloud path) and a 3D car that
actually moves in response to that traffic.

Every security claim it makes is **measured, not asserted** — see
[Evidence](#evidence-measured) below.

> ⚠️ **Simulation only.** Nothing here talks to real hardware, a real radio, or
> a real vehicle. Every "attack" is a software model of a well-documented class
> of automotive-security issue, built for learning and defensive understanding.
> It is deliberately incapable of controlling a real car.

## Evidence (measured)

The claims are backed by a headless harness that runs the **exact same logic
modules** the browser runs, over many trials, and writes a report:

```bash
node test/evidence.js      # -> evidence/report.json + evidence/RESULTS.md
```

Verdicts are split on purpose — a reproduced **vulnerability** means the model
is faithful, *not* that the system is secure. Latest run
([full report](evidence/RESULTS.md)):

**Security properties (must hold):**

| Property | Verdict | Measurement |
|---|---|---|
| Crypto correct (FIPS-180-4 + RFC 4231) | ✅ UPHELD | SHA-256 & HMAC vectors match byte-for-byte |
| Rolling code rejects replay | ✅ UPHELD | 1000/1000 legit accepted, 0/1000 replays |
| Keyed HMAC resists forgery | ✅ UPHELD | keyless forged in **1** attempt; HMAC **0**/500,000 guesses (≈2³¹) |
| SecOC blocks CAN injection | ✅ UPHELD | SecOC on → 0 m moved; off → 8 m @ 27.5 kph, gear D |
| SecOC freshness blocks replay | ✅ UPHELD | 0/100 replays of a valid signed frame accepted |
| Gateway auth | ✅ UPHELD | owner token forwarded, attacker blocked |
| Distance bounding decisive at UWB precision | ✅ UPHELD | σ≈0.7 ns (10 cm) → relay 0% at 0.1% false-reject |

**Vulnerabilities reproduced (expected to succeed — this is the threat, not a pass):**

| Known weakness | Verdict | Measurement |
|---|---|---|
| Relay of a live code (no distance bounding) | ⚠️ REPRODUCED | 1000/1000 relayed codes unlock |
| RollJam (jam + capture + replay) | ⚠️ REPRODUCED | 1000/1000 attempts unlock |

**Design sweep — how much timing precision must distance bounding buy?** The τ
threshold is bounded below by ranging noise σ, so σ is the real design axis. For
each σ we take the *tightest* τ an honest owner tolerates (false-reject ≤ 0.1%)
and measure the residual relay success (15 m relay + 20 ns hardware latency;
honest fob 0.3–2 m; 300 k trials per σ):

| σ (ns) | ≈ ranging accuracy | tightest τ | relay success | honest false-reject |
|---:|---:|---:|---:|---:|
| 0.7 (real UWB) | 0.10 m | 14.6 ns | **0%** | 0.1% |
| 5 | 0.75 m | 25.8 ns | 0% | 0.1% |
| 15 | 2.25 m | 55.2 ns | 0% | 0.1% |
| 30 | 4.5 m | 100 ns | 25.6% | 0.1% |
| 60 | 8.99 m | 193 ns | 88.6% | 0.1% |

Honest false-reject is pinned at the budget in every row — the free variable is
**relay success**. Distance bounding isn't a fragile compromise: it's *decisive
if and only if you buy UWB-class timing*. Keep ranging accuracy under ~2 m
(σ≲15 ns) and the relay is crushed to 0%; let it degrade to 4.5 m and one relay
in four gets through; at 9 m it's ~89% broken. UWB's 10 cm has ~20× margin —
which is exactly why the CCC Digital Key standard uses UWB. This table is a
procurement spec, not one configuration.

**Rolling-code window — two measured failure modes** (λ = out-of-range press
rate, swept; table at λ=2):

| window W | honest lockout | attacker capture-replay |
|---:|---:|---:|
| 1 | 86.5% | 49.8% |
| 2 | 59.5% | 72.7% |
| 4 | 14.2% | 85.2% |
| 8 | 0.1% | 86.5% |
| 16+ | 0% | 86.5% |

Both columns are measured and move oppositely: a narrow window shrinks the odds a
sniffed unused code still lies inside it, but desyncs honest users who pressed
out of range. λ is swept in [the full report](evidence/RESULTS.md) rather than
assumed.

The crypto is **real**: `js/crypto.js` is a dependency-free, byte-exact
SHA-256 / HMAC-SHA-256 validated against the FIPS-180-4 and RFC 4231 test
vectors at startup (`SIM.Crypto.selfTest()`). The `weak` keyless checksum is
kept **only** so the harness can demonstrate — with numbers — why an
unauthenticated integrity check is forgeable while a keyed MAC is not.

## Run it

Zero build step:

```bash
python -m http.server 8123      # then open http://localhost:8123
```

Or double-click `index.html` (loads Three.js as classic scripts from a CDN, so
it runs straight off the filesystem). The 3D loop uses `requestAnimationFrame`,
so it advances only while the tab is visible.

## The chain being modelled

```
 Key fob (RF, HMAC rolling code) ─┐
 Phone app / cloud ───────────────┤→ GATEWAY ─→ [ CAN BUS ] ─→ ECUs ─→ physics ─→ 3D car
 Remote-drive rig (laptop) ───────┘  (auth)    (SecOC verify)  ECM/EPS/ABS/BCM
```

Trust on the internal bus is **cryptographic, not a source label**: the gateway
signs command frames (SecOC — a MAC over `id|data|freshness`), and every ECU
honours a command only if that MAC verifies and the freshness counter advanced.
An attacker who splices onto the bus can send frames, but cannot forge the MAC
without the key, and cannot replay an old one past the freshness check.

| File | Role |
|------|------|
| `js/crypto.js` | **SHA-256 / HMAC-SHA-256** (validated), truncated-MAC helper, and **SecOC** sign/verify with freshness |
| `js/distancebound.js` | round-trip-time ranging + τ threshold — the anti-relay countermeasure (UWB / CCC Digital Key) |
| `js/core.js` | clock, event bus, security posture (SecOC toggle + bus key) |
| `js/can.js` | CAN bus + DBC-style codec (11-bit IDs, 8-byte frames, little-endian packing, counter + checksum); authenticates command frames once per delivery |
| `js/ecu.js` | ECM, EPS, ABS, BCM, PLANT, and the **security GATEWAY** (signs commands, gates external requests) |
| `js/rke.js` | key fob, HMAC rolling-code receiver, RF channel, and the replay/relay/RollJam attacks |
| `js/telematics.js` | cellular phone→cloud→car remote path (Bluelink-style) |
| `js/vehicle.js` | kinematic bicycle-model physics |
| `js/scene.js` | Three.js car + world + chase camera |
| `js/ui.js` | HUD, live CAN monitor, event log, controls |
| `js/main.js` | wiring + fixed-step 50 Hz sim loop |
| `test/evidence.js` | headless measurement harness (the source of the table above) |

## Try the attack chain (panel, top to bottom)

1. **Keyless entry.** `Fob Unlock` works. `Replay Last` is rejected (rolling
   code). `Relay Live` succeeds (a live code is genuine). Turn on the **jammer**,
   press the fob, then `Replay` — that's **RollJam**, and it works because the
   car never advanced past that counter. Now flip on **Distance bounding**: the
   relay dies (its round-trip time exceeds τ), and the τ slider shows the ceiling
   shrink. At the modeled UWB precision honest presses stay safe across the whole
   slider — the precision-vs-relay tradeoff (and where it breaks) lives in the σ
   design sweep in [the report](evidence/RESULTS.md).
2. **Telematics.** `Owner Start` carries the token and goes through. `Attacker
   Start` is blocked — until you turn off *Gateway requires auth*.
3. **Ignition & gear.** `Start Engine`, select **D**, then drive with
   **W/A/S/D** or the arrow keys.
4. **Security posture.** Arm *Attacker: inject DRIVE_CMD on bus*. With **SecOC**
   on, the ECUs reject the (unsigned) injected full-throttle command. Turn SecOC
   off and the same injection drives the car away by itself — the whole point: a
   flat, unauthenticated bus obeys anyone who can reach it.

Watch the **CAN monitor** (bottom left) throughout: every signal is decoded
live, the `@SRC` tag shows `GATEWAY` vs `ATTACKER`, and bad-checksum frames are
highlighted.

## What's intentionally abstracted (and what is not)

**Real:** SHA-256/HMAC (validated vectors), SecOC-style MAC + monotonic
freshness, rolling-code counter windowing, CAN frame framing and signal
packing.

**Abstracted, by design:**

- MACs are truncated (32-bit for the short RF fob code, 64-bit on the bus);
  production SecOC/AUTOSAR typically uses AES-CMAC — the *construction and
  freshness logic* are the point and are faithful.
- One CAN bus, not the segmented multi-bus + central gateway of a modern car.
- Cellular latency is a fixed delay; no real carrier/cloud.
- Physics is a kinematic bicycle model (no tire slip / weight transfer).

Each is a natural next step: AES-CMAC, ISO-TP + UDS diagnostics (incl. 0x27
security access), and multi-bus segmentation.
