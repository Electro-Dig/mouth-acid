/* Mouth × Acid · 声音引擎（AudioWorklet）
   声音照抄“Acid 的八种玩法”（D:\claude\acid-learn\site\engine.js，和 acid-play 视频同一套）：
   锯齿 / 方波 → 四级梯形低通（共振反馈带软削波，不自激）→ 失真；重音会“攒劲”、滑音 RC 22 ms；附点八分乒乓延时（反馈里带低通）；
   底鼓 / 军鼓 / 闭镲 / 开镲 / rim，和弦垫、坦普拉长音；一步里连打两下、连音。
   这里多出来的：CUTOFF / RESO / ENV 由嘴实时给（逐采样平滑）；第二个共振峰（“两个峰”，303 原机没有）；自由说话 = 张嘴开门。
   输出 0 = 干声，输出 1 = 混响送入（主线程接卷积混响，见 app.js 的 buildChain）。
   消息：{type:'p', p} 目标值 · {type:'acc'} 重音 · {type:'pat', i} 下一小节换音型 · {type:'reset'}
   processorOptions：{ init, presets:[{steps, p}], script:[[秒, p | 'acc' | ['pat', i]]] }（script 给离线检查用） */

const TAU = 6.283185307179586, mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const blep = (p, dt) => p < dt ? (p /= dt, p + p - p * p - 1) : p > 1 - dt ? (p = (p - 1) / dt, p * p + p + p + 1) : 0;
function nz(s) { s.n = (s.n * 1664525 + 1013904223) >>> 0; return s.n / 2147483648 - 1; }
class Svf { constructor() { this.a = 0; this.b = 0; }
  run(x, fc, Q) { const g = Math.tan(Math.PI * Math.min(fc, sampleRate * 0.45) / sampleRate), k = 1 / Q, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - this.b, v1 = a1 * this.a + a2 * v3, v2 = this.b + a2 * this.a + a3 * v3; this.a = 2 * v1 - this.a; this.b = 2 * v2 - this.b; this.bp = v1; return v2; } }

class Voice {
  constructor() { this.ph = 0; this.s1 = this.s2 = this.s3 = this.s4 = 0; this.hp = this.hpx = 0; this.m = 45; this.mT = 45; this.amp = 0; this.gate = 0; this.env = 0; this.accT = 0; this.accSm = 0; this.u = 9; this.isAcc = 0; this.b1 = 0; this.b2 = 0; this.fc = 300; }
  trig(m, acc, legato) {
    this.mT = m; this.gate = 1;
    if (!legato) { this.m = m; this.env = 1; this.u = 0; this.isAcc = acc; if (acc) this.accT += 1; }
  }
  accent() { this.env = 1; this.u = 0; this.isAcc = 1; this.accT += 1; }
  // K：平滑后的嘴部参数 {cut, res, env, f2, f2amt}；P：音型参数 {dec, drv, accAmt}；hold = 自由说话（长音不衰减）
  run(K, P, sr, wave, hold) {
    const dt = 1 / sr;
    this.m += (this.mT - this.m) * (1 - Math.exp(-dt / 0.022));
    const f = mtof(this.m), dtp = f / sr;
    this.ph += dtp; if (this.ph >= 1) this.ph -= 1;
    const saw = (2 * this.ph - 1) - blep(this.ph, dtp);
    let src = saw;
    if (wave > 0.001) { const p2 = (this.ph + 0.5) % 1, sq = (this.ph < 0.5 ? 1 : -1) + blep(this.ph, dtp) - blep(p2, dtp); src = saw + (sq * 0.85 - saw) * wave; }
    this.u += dt;
    this.env *= Math.exp(-dt / (this.isAcc ? 0.2 : P.dec));
    this.accT *= Math.exp(-dt / 0.22); this.accSm += (this.accT - this.accSm) * (1 - Math.exp(-dt / 0.025));
    const accV = Math.tanh(this.accSm * 0.45);   // 连着几个重音，一个比一个叫得高
    const fc = Math.min(14000, K.cut * Math.pow(2, 3.6 * this.env * K.env + 2.4 * accV * (P.accAmt ?? 1))), k = 3.7 * K.res;
    const g = Math.tan(Math.PI * Math.min(fc, sr * 0.45) / sr), G = g / (1 + g), G2 = G * G, G4 = G2 * G2, ig = 1 / (1 + g);
    const S = G2 * G * this.s1 * ig + G2 * this.s2 * ig + G * this.s3 * ig + this.s4 * ig, x = 0.85 * src;
    const y4p = (G4 * x + S) / (1 + k * G4), uu = Math.tanh(1.3 * (x - k * y4p)) / 1.3;
    let v = (uu - this.s1) * G, y1 = v + this.s1; this.s1 = y1 + v;
    v = (y1 - this.s2) * G; const y2 = v + this.s2; this.s2 = y2 + v;
    v = (y2 - this.s3) * G; const y3 = v + this.s3; this.s3 = y3 + v;
    v = (y3 - this.s4) * G; const y4 = v + this.s4; this.s4 = y4 + v;
    let a = y4 * (1 + 0.5 * k);
    // 第二个共振峰（“两个峰”）：带通 SVF，Q≈9，和第一个峰并联
    if (K.f2amt > 0.002) {
      const g2 = Math.tan(Math.PI * Math.min(K.f2, sr * 0.4) / sr), kq = 0.11, a1 = 1 / (1 + g2 * (g2 + kq)), a2c = g2 * a1, a3 = g2 * a2c;
      const v3 = src - this.b2, v1 = a1 * this.b1 + a2c * v3, v2 = this.b2 + a2c * this.b1 + a3 * v3;
      this.b1 = 2 * v1 - this.b1; this.b2 = 2 * v2 - this.b2;
      a += kq * v1 * K.f2amt * 3.2;
    }
    const hpo = a - this.hpx + 0.995 * this.hp; this.hpx = a; this.hp = hpo;
    const tgt = this.gate ? (this.isAcc ? 1.35 : 1) * (hold ? 1 : Math.exp(-this.u / 3)) : 0;
    this.amp += (tgt - this.amp) * (1 - Math.exp(-dt / (this.gate ? 0.003 : (hold ? 0.045 : 0.006))));
    if (this.amp < 1e-7 && !this.gate) this.amp = 0;
    this.fc = fc;
    return Math.tanh(1.1 * P.drv * hpo * this.amp) / (0.75 + 0.25 * P.drv);
  }
}

const DRUMS = {   // 每种鼓型：[类型, 步, 力度]
  four: [['kick', [0, 4, 8, 12], 0.8], ['chat', [2, 6, 10, 14], 0.25]],
  minimal: [['kick', [0, 4, 8, 12], 0.6], ['chat', [2, 10], 0.14], ['rim', [3, 11], 0.32]],
  soft: [['kick', [0, 4, 8, 12], 0.42], ['chat', [2, 6, 10, 14], 0.11]],
  disco: [['kick', [0, 4, 8, 12], 0.55], ['ohat', [2, 6, 10, 14], 0.28], ['snare', [4, 12], 0.24], ['chat', [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15], 0.1]],
  big: [['kick', [0, 4, 8, 12], 0.95], ['ohat', [2, 6, 10, 14], 0.5], ['chat', [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15], 0.24], ['snare', [4, 12], 0.5]],
  none: [],
};
const PADS = [[45, 52, 55, 59, 60], [41, 48, 52, 57], [50, 53, 57, 60, 64], [40, 47, 50, 55, 56]];   // Am9 · Fmaj7 · Dm9 · E7sus
const TANP = [40, 45, 45, 33];
// 自由说话：没有音序，鼓（打开时）用最简单的四拍
const FREE = { bpm: 120, dec: 0.3, drv: 1, send: 0.12, fb: 0.42, lvl: 0.9, verb: 0.12, drums: 'four', accAmt: 1, gate: 0.5, swing: 0, pad: 0, drone: 0 };

class MouthAcid extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {}, sr = sampleRate;
    this.presets = p.presets || [{ steps: [{ n: 0, acc: 1, sl: 0, rest: 0 }], p: FREE }];
    // 目标值（主线程改这些）
    this.T = { mode: 'free', cut: 300, res: 0.55, env: 0.5, f2: 1500, f2amt: 0, verbAdd: 0, verbHold: 0, tr: 0, root: 45, gate: 0, lvl: 1, wave: 0, drums: 0, vol: 1 };
    if (p.init) Object.assign(this.T, p.init);
    // 平滑后的嘴部参数
    this.K = { cut: 300, res: 0.55, env: 0.5, f2: 1500, f2amt: 0 }; this.lc = Math.log(300); this.l2 = Math.log(1500); this.vadd = 0; this.space = 0; this.lv = 1; this.wv = 0;
    const kc = t => 1 - Math.exp(-1 / (t * sr));
    this.cCut = kc(0.006); this.cRes = kc(0.025); this.cSlow = kc(0.08);
    this.va = new Voice(); this.gPrev = 0;
    this.pat = 0; this.nextPat = -1; this.A = this.presets[0].steps; this.step = -1; this.sPh = 1; this.curA = null; this.ratDone = false; this.pendAcc = 0; this.lastStepAt = -9;
    this.dt = {}; this.dv = {}; this.tp = []; this.padT = -9; this.padPrev = null; this.padCur = null; this.padPrevT = -9; this.time = 0;
    this.sn = new Svf(); this.ns = { n: 22222 }; this.prevN = 0;
    this.DN = Math.ceil(sr * 1.2); this.dL = new Float32Array(this.DN); this.dR = new Float32Array(this.DN); this.dw = 0; this.dlp = 0; this.dsm = 0;
    this.xhp = 0; this.xhpx = 0;
    this.script = p.script || null; this.sp = 0; this.tel = 0;
    this.port.onmessage = e => this.msg(e.data);
  }
  get P() { return this.T.mode === 'seq' ? (this.presets[this.pat] || this.presets[0]).p : FREE; }
  msg(d) {
    if (d.type === 'p') { const was = this.T.mode; Object.assign(this.T, d.p); if (this.T.mode !== was) this.reset(); }
    else if (d.type === 'acc') this.userAccent();
    else if (d.type === 'pat') this.nextPat = d.i;
    else if (d.type === 'reset') this.reset();
  }
  reset() { this.step = -1; this.sPh = 1; this.nextPat = -1; this.curA = null; if (this.T.mode === 'seq') this.va.gate = 0; }
  userAccent() {
    if (this.T.mode === 'seq') { if (this.time - this.lastStepAt < 0.04 && this.curA) this.va.accent(); else this.pendAcc = 1; }   // 刚过去 40 ms 内有一步：补在这一步上
    else this.va.accent();
  }
  onStep() {
    const s = ++this.step, j = s % 16, T = this.T;
    if (T.mode === 'seq' && j === 0 && this.nextPat >= 0) { this.pat = this.nextPat; this.nextPat = -1; }
    const P = this.P;
    this.lastStepAt = this.time;
    if (T.mode === 'seq') {
      const A = this.A = (this.presets[this.pat] || this.presets[0]).steps, nA = A.length, q = A[s % nA], pq = A[(s - 1 + nA) % nA];
      if (q && !q.rest) {
        const legato = s > 0 && pq && !pq.rest && pq.sl, acc = q.acc || this.pendAcc;
        this.va.trig(T.root + T.tr + q.n, acc, legato); this.curA = q;
        if (this.pendAcc && legato) this.va.accent();
        this.pendAcc = 0;
      } else { this.va.gate = 0; this.curA = null; }
    }
    if (T.drums) for (const [type, steps, v] of DRUMS[P.drums] || []) if (steps.includes(j)) { this.dt[type] = this.time; this.dv[type] = v; }
    if (T.mode === 'seq' && P.drone && j % 4 === 0) { this.tp.push({ t: this.time, m: TANP[(j >> 2) % 4] + T.tr }); if (this.tp.length > 4) this.tp.shift(); }
    if (T.mode === 'seq' && P.pad && j === 0) { this.padPrev = this.padCur; this.padPrevT = this.padT; this.padCur = PADS[(s >> 4) % 4].map(m => m + T.tr); this.padT = this.time; }
  }
  process(_, outs) {
    const O = outs[0], X = outs[1], L = O[0], R = O[1], XL = X[0], XR = X[1], n = L.length, sr = sampleRate, dt = 1 / sr, T = this.T, K = this.K;
    for (let i = 0; i < n; i++) {
      if (this.script) { while (this.sp < this.script.length && this.script[this.sp][0] <= this.time) { const e = this.script[this.sp++][1];
        if (e === 'acc') this.userAccent(); else if (Array.isArray(e)) this.nextPat = e[1]; else this.msg({ type: 'p', p: e }); } }
      this.time += dt;
      const P = this.P;
      // ---- 嘴部参数逐采样平滑（30 Hz 进来的台阶不会变成咔哒声） ----
      this.lc += (Math.log(T.cut) - this.lc) * this.cCut; K.cut = Math.exp(this.lc);
      K.res += (T.res - K.res) * this.cRes; K.env += (T.env - K.env) * this.cRes;
      this.l2 += (Math.log(T.f2) - this.l2) * this.cCut; K.f2 = Math.exp(this.l2); K.f2amt += (T.f2amt - K.f2amt) * this.cRes;
      // 挑眉 = 空间：0–1。混响送入最多 +0.75，延迟送入最多 +0.45、反馈最多 +0.25（回声更多次）；按住 = 一下甩满
      this.space += ((T.verbHold ? 1 : T.verbAdd) - this.space) * this.cSlow; this.vadd = 0.75 * this.space; this.lv += (T.lvl - this.lv) * this.cRes; this.wv += (T.wave - this.wv) * this.cSlow;
      // ---- 时钟：16 分音符（带摇摆）；自由说话里只给鼓用 ----
      if (T.mode === 'seq' || T.drums) {
        const sl = 15 / P.bpm * (1 + ((this.step + 1) % 2 ? -(P.swing || 0) : (P.swing || 0)) * 0.5);
        this.sPh += dt / sl;
        if (this.sPh >= 1) { this.sPh -= 1; this.onStep(); }
      }
      if (T.mode === 'seq') {
        // 门：半步后合上（滑音的步一直开着）；一步里连打两下的，半步处再起一次
        const q = this.curA;
        if (q) {
          const nx = this.A[(this.step + 1) % this.A.length];
          if (q.rat) {
            if (this.sPh < 0.5) this.ratDone = false;
            else if (!this.ratDone) { this.ratDone = true; this.va.trig(T.root + T.tr + q.n, q.acc, false); }
            this.va.gate = this.sPh < 0.42 || (this.sPh >= 0.5 && this.sPh < 0.92) ? 1 : 0;
          } else if (!(q.sl && nx && !nx.rest) && this.sPh > (P.gate || 0.5)) this.va.gate = 0;
        }
      } else {
        // 自由说话：张嘴开门，开门那一下起包络；移调滑过去
        const g = T.gate ? 1 : 0;
        if (g && !this.gPrev) this.va.trig(T.root + T.tr, 0, this.va.amp > 0.02);
        else if (g) this.va.mT = T.root + T.tr;
        if (!g) this.va.gate = 0;
        this.gPrev = g;
      }
      // ---- 303 ----
      const kt = this.time - (this.dt.kick ?? -9), dk = !T.drums || kt > 1.2 ? 0 : kt < 0.006 ? kt / 0.006 : Math.exp(-(kt - 0.006) / 0.11);   // 底鼓响时让一让
      const wave = T.mode === 'seq' ? (P.wave || 0) : this.wv;
      const a = this.va.run(K, P, sr, wave, T.mode === 'free') * P.lvl * 0.62 * (1 - 0.3 * dk) * (T.mode === 'free' ? this.lv : 1);
      let l = a, r = a;
      // ---- 混响送入：音型自带的量 + 挑眉加的量；先切掉 200 Hz 以下，低音不糊 ----
      const vs = a * (P.verb + this.vadd), xh = vs - this.xhpx + 0.974 * this.xhp; this.xhpx = vs; this.xhp = xh;
      let xl = xh;
      // ---- 附点八分（3 步）乒乓延时 ----
      const DS = 3 * 15 / P.bpm * sr; this.dsm = this.dsm ? this.dsm + (DS - this.dsm) * 0.0004 : DS;
      const dp = this.dw - Math.min(this.DN - 2, this.dsm), i0 = Math.floor(dp), fr = dp - i0, ia = (i0 + this.DN) % this.DN, ib = (ia + 1) % this.DN;
      const dl = this.dL[ia] + (this.dL[ib] - this.dL[ia]) * fr, dr = this.dR[ia] + (this.dR[ib] - this.dR[ia]) * fr;
      this.dlp += 0.35 * (dr - this.dlp);
      this.dL[this.dw] = a * (P.send + 0.45 * this.space) + this.dlp * Math.min(0.72, P.fb + 0.25 * this.space); this.dR[this.dw] = dl * 0.9; this.dw = (this.dw + 1) % this.DN;
      l += dl * 0.8; r += dr * 0.8; xl += (dl + dr) * 0.15;
      // ---- 鼓 ----
      if (T.drums) {
        const w0 = nz(this.ns), hpn = (w0 - this.prevN) * 0.5; this.prevN = w0;
        const snz = this.sn.run(w0, 2600, 0.7);
        let tau = this.time - (this.dt.kick ?? -9); if (tau < 1) { const kv = (Math.sin(TAU * (47 * tau + 3.4 * (1 - Math.exp(-tau / 0.03)))) * Math.exp(-tau / 0.3) + 0.1 * Math.sin(TAU * 160 * tau) * Math.exp(-tau / 0.015)) * 0.7 * this.dv.kick * Math.min(1, tau / 0.002); l += kv; r += kv; }
        tau = this.time - (this.dt.snare ?? -9); if (tau < 1) { const sv = Math.min(1, tau / 0.004) * (0.32 * Math.sin(TAU * (182 * tau + 1.4 * (1 - Math.exp(-tau / 0.02)))) * Math.exp(-tau / 0.07) + 0.55 * snz * Math.exp(-tau / 0.11)) * this.dv.snare; l += sv; r += sv; xl += sv * 0.3; }
        tau = this.time - (this.dt.rim ?? -9); if (tau < 0.3) { const rv = Math.min(1, tau / 0.001) * (Math.sin(TAU * 1700 * tau) * 0.6 + Math.sin(TAU * 820 * tau) * 0.4) * Math.exp(-tau / 0.018) * 0.22 * this.dv.rim; l += rv * 0.7; r += rv; xl += rv * 0.6; }
        tau = this.time - (this.dt.ohat ?? -9); if (tau < 1) { const hv = hpn * 0.12 * Math.exp(-tau / 0.12) * Math.min(1, tau / 0.002) * this.dv.ohat; l += hv * 0.8; r += hv; }
        tau = this.time - (this.dt.chat ?? -9); if (tau < 0.4) { const hv = hpn * 0.07 * Math.exp(-tau / 0.028) * Math.min(1, tau / 0.002) * this.dv.chat; l += hv; r += hv * 0.8; }
      }
      // ---- 坦普拉（Raga）、和弦垫（Deep） ----
      if (T.mode === 'seq' && P.drone) for (const q of this.tp) {
        const u = this.time - q.t; if (u < 0 || u > 4) continue;
        const f = mtof(q.m), env = Math.min(1, u / 0.01) * Math.exp(-u / 1.8); let s = 0;
        for (let h = 1; h <= 7; h++) s += Math.sin(TAU * f * h * u) / h * (h > 3 ? 0.6 + 0.4 * Math.sin(TAU * 0.9 * u + h) : 1);
        const tv = s * env * 0.035; l += tv * 0.85; r += tv; xl += tv * 0.8;
      }
      if (T.mode === 'seq' && P.pad) for (const [ch, t0, isPrev] of [[this.padCur, this.padT, 0], [this.padPrev, this.padPrevT, 1]]) {
        if (!ch) continue; const u = this.time - t0, rel = isPrev ? this.time - this.padT : -1, env = Math.min(1, u / 0.35) * (rel > 0 ? Math.exp(-rel / 0.5) : 1);
        if (env < 0.001) continue;
        let ps = 0; for (const m of ch) { const f = mtof(m + 12); ps += Math.sin(TAU * f * u) + 0.5 * Math.sin(TAU * f * 1.003 * u + 1) + 0.18 * Math.sin(TAU * 2 * f * u); }
        const pv = ps * env * 0.022; l += pv; r += pv; xl += pv * 0.9;
      }
      L[i] = Math.tanh(l) * T.vol; R[i] = Math.tanh(r) * T.vol; XL[i] = XR[i] = xl * T.vol;
    }
    if (++this.tel % 6 === 0) this.port.postMessage({ fc: this.va.fc, cut: K.cut, res: K.res, env: K.env, m: this.va.m, a: this.va.amp, step: this.step < 0 ? -1 : this.step % (this.A.length || 16), pat: this.pat, f2: K.f2, a2: K.f2amt, send: this.space });
    return true;
  }
}
registerProcessor('lip303', MouthAcid);
