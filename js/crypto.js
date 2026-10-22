(function (SIM) {
  'use strict';

  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);

  function sha256(msg) {                         // msg: Uint8Array -> Uint8Array(32)
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                               0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const l = msg.length;
    const k = (56 - (l + 1) % 64 + 64) % 64;
    const total = l + 1 + k + 8;
    const m = new Uint8Array(total);
    m.set(msg); m[l] = 0x80;
    const dv = new DataView(m.buffer);
    const bits = l * 8;
    dv.setUint32(total - 4, bits >>> 0, false);
    dv.setUint32(total - 8, Math.floor(bits / 0x100000000), false);
    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
        const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
      }
      let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
      H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
    }
    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
    return out;
  }

  function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

  function hmac(key, msg) {                       // both Uint8Array -> Uint8Array(32)
    const B = 64;
    if (key.length > B) key = sha256(key);
    const k = new Uint8Array(B); k.set(key);
    const ip = new Uint8Array(B), op = new Uint8Array(B);
    for (let i = 0; i < B; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
    return sha256(concat(op, sha256(concat(ip, msg))));
  }

  function hex(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += ('0'+bytes[i].toString(16)).slice(-2); return s; }
  function strBytes(s) { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; }
  function u32le(n) { return new Uint8Array([n & 255, (n>>>8)&255, (n>>>16)&255, (n>>>24)&255]); }

  // Truncated HMAC. bits in {16, 32, 64, ...}.
  function tag(key, msg, bits) { return hex(hmac(key, msg)).slice(0, bits / 4); }

  // Non-cryptographic (FNV-1a style). Exists only to be broken in the evidence.
  function weakTag(msg, bits) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < msg.length; i++) { h ^= msg[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8).slice(0, bits / 4);
  }

  function selfTest() {
    const shaAbc = hex(sha256(strBytes('abc')));
    const shaOk = shaAbc === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    // RFC 4231 test case 1
    const key = new Uint8Array(20).fill(0x0b);
    const hmacOk = hex(hmac(key, strBytes('Hi There'))) ===
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';
    return { sha256_abc: shaOk, hmac_rfc4231_1: hmacOk, pass: shaOk && hmacOk };
  }

  SIM.Crypto = { sha256, hmac, tag, weakTag, hex, strBytes, u32le, concat, selfTest };

  // SecOC: MAC over (id|data|fv) plus strictly increasing freshness, so both
  // forgery and replay are rejected cryptographically.
  const TAG_BITS = 64;
  function macMsg(id, data, fv) {
    return SIM.Crypto.concat(SIM.Crypto.concat(u32le(id), data), u32le(fv));
  }
  const SecOC = {
    txFV: {}, rxFV: {}, tagBits: TAG_BITS,
    sign(frame, key) {
      const fv = (this.txFV[frame.id] = (this.txFV[frame.id] || 0) + 1);
      frame.fv = fv;
      frame.mac = SIM.Crypto.tag(key, macMsg(frame.id, frame.data, fv), this.tagBits);
    },
    verify(frame, key) {
      if (frame.mac == null || frame.fv == null) return false;
      if (frame.mac !== SIM.Crypto.tag(key, macMsg(frame.id, frame.data, frame.fv), this.tagBits)) return false;
      if (frame.fv <= (this.rxFV[frame.id] || 0)) return false;
      this.rxFV[frame.id] = frame.fv;
      return true;
    },
    reset() { this.txFV = {}; this.rxFV = {}; },
  };
  SIM.SecOC = SecOC;
})(globalThis.SIM = globalThis.SIM || {});
