/* 对口型 303 · 主程序
   摄像头 / 测试视频 → face-worker.js（MediaPipe Face Landmarker，478 点 + blendshape）→ 嘴部特征 → 校准归一 → 1€ 滤波 → 映射成 303 参数 → worklet。
   张嘴高度 = CUTOFF，嘴圆（嘟嘴）= RESO，嘴宽（咧嘴）= ENV MOD（元音模式里 = 第二个共振峰），
   突然张嘴 / 点头 = 重音，歪头 = 移调，单眼眨 = 换音型，挑眉 = 混响加量。没有摄像头时，鼠标 / 触屏喂同一套流程。
   延迟做法照 D:\Codex\air-cello-prototype：识别在 Worker 里、主线程最多一帧在路上且永远送最新帧；
   用 requestVideoFrameCallback 的 presentedFrames 认新帧（实时流的 video.currentTime 随墙钟走，拿它判断会重复识别同一帧）；
   分段计时（推理 / 发帧→控制 / 采集→控制），可导出 JSON。?video=<文件> 用本地视频走完全相同的管线测延迟，&bench=<秒> 自动出报告。 */

import { createBeauty } from './beauty.js?v=1';

const $ = s => document.querySelector(s);
const video = $('#cam'), mirror = $('#mirror'), ov = $('#ov'), og = ov.getContext('2d'), sp = $('#sp'), sg = sp.getContext('2d'), linkP = $('#link-p');
const Q = new URLSearchParams(location.search);
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v, lerp = (a, b, u) => a + (b - a) * u;
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const mName = m => { const r = Math.round(m); return NOTE[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };
const fmtHz = f => f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : Math.round(f) + ' Hz';
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }, del(k) { try { localStorage.removeItem(k); } catch (e) {} } };
const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

/* ---------------- MediaPipe 来源：先本地（部署时自托管），失败再走官方地址 ---------------- */
const MP_VER = '0.10.14';
const abs = p => new URL(p, location.href).href;
const MP_LOCAL = { name: '本地', js: abs('./lib/mediapipe/vision_bundle.mjs'), wasm: abs('./lib/mediapipe/wasm'), model: abs('./lib/mediapipe/face_landmarker.task') };
const MP_CDN = { name: '官方地址', js: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`, wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`,
  model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' };
const mpSources = () => document.documentElement.dataset.mp === 'cdn' || Q.get('mp') === 'cdn' ? [MP_CDN] : [MP_LOCAL, MP_CDN];
// 第一次打开要下约 6 MB（wasm 2.6 MB 压缩后 + 模型 3.7 MB）。以前点了开始才下、两个文件一个接一个、下完才出画面：慢网要等 20 秒，还是黑盒。
// 现在一打开网页就同时下两个，开始页和画面上都有进度条；total 是解压后的字节数（Netlify 对 wasm 用 br 压缩，读到的是解压后的）
const PRE = { got: { wasm: 0, model: 0 }, total: { wasm: 9423986, model: 3758596 }, done: false, err: null, p: null };
const preFrac = () => PRE.done ? 1 : Math.min(0.99, (PRE.got.wasm + PRE.got.model) / (PRE.total.wasm + PRE.total.model));
async function grab(url, k) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(url + ' ' + r.status);
  const len = +r.headers.get('content-length') || 0;
  if (len && !r.headers.get('content-encoding')) PRE.total[k] = len;
  const rd = r.body.getReader(), parts = [];
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); PRE.got[k] += value.length; }
  return new Blob(parts);
}
function preload() {
  if (!PRE.p) PRE.p = (async () => {
    const src = mpSources()[0];
    // 两个小脚本（bundle 和 wasm 加载器）也一起先下进缓存，不然 Worker 要等大文件下完才去拿它们（实测多等 3 秒）
    for (const u of [src.js, src.wasm + '/vision_wasm_internal.js']) fetch(u).then(r => r.blob()).catch(() => {});
    const [w, m] = await Promise.all([grab(src.wasm + '/vision_wasm_internal.wasm', 'wasm'), grab(src.model, 'model')]);
    PRE.done = true;
    return { src, bin: URL.createObjectURL(new Blob([w], { type: 'application/wasm' })), model: await m.arrayBuffer() };
  })().catch(e => { PRE.err = e; console.warn('[06] 预下载没成功，改走原来的地址', e); return null; });
  return PRE.p;
}
// Edge 的「增强安全性」（默认“平衡”：不常去的网站自动打开）会关掉 JS / WebAssembly 的 JIT：识别模型要么起不来，要么慢得像卡死
const IS_EDGE = /Edg\//.test(navigator.userAgent), NO_WASM = typeof WebAssembly !== 'object';
let recFail = null;
const edgeTip = () => IS_EDGE ? L('Edge 用户：点地址栏左边的锁图标 → 关掉「增强此网站的安全性」，再刷新页面；或者换 Chrome。', 'In Edge: click the lock in the address bar → turn off “Enhanced security for this site”, then reload. Or try Chrome.')
  : L('试试 Chrome，或者先用鼠标 / 手指玩。', 'Try Chrome, or play with mouse / touch.');
const loadText = () => recDone ? L('识别模型已就绪', 'Face model ready') : PRE.err ? L('加载识别模型…', 'Loading face model…') : PRE.done ? L('准备识别模型…', 'Starting face model…') : L('加载识别模型 ', 'Loading face model ') + Math.round(preFrac() * 100) + '%';

/* ---------------- 音型：从“Acid 的八种玩法”（D:\claude\acid-learn\site\widgets.js）搬来 5 种 ----------------
   不搬：两台 303 对话、拧到尖叫（失真 Acid）、Acid Breaks。
   一步：[比根音高几个半音, 重音, 滑到下一步, 0 音 / 1 休止 / 2 连音（和上一步连成一个长音）, 一步里连打两下]
   p：节奏和音色（CUTOFF / RESO / ENV 由嘴给，这里的 res / env 是“嘴放松时”的出发点） */
const PRESETS = [
  { name: 'Chicago', zh: '芝加哥 Acid House', en: 'Chicago acid house', raw: [[0,1,0,0],[0,0,0,0],[12,0,0,0],[0,0,0,0],[0,1,0,0],[0,0,1,0],[12,0,0,0],[0,0,0,0],[0,1,0,0],[0,0,0,0],[12,0,1,0],[10,0,0,0],[0,1,0,0],[0,0,0,0],[12,0,0,0],[3,0,0,0]],
    p: { bpm: 122, res: 0.86, env: 0.5, dec: 0.35, wave: 0, drv: 1, send: 0, fb: 0.42, lvl: 0.9, verb: 0.12, drums: 'four' } },
  { name: 'Raga', zh: 'Raga Acid', en: 'Raga acid', raw: [[0,1,0,0],[0,0,0,2],[1,0,1,0],[4,0,0,0],[5,0,1,0],[7,1,0,0],[7,0,0,2],[8,0,1,0],[7,0,0,0],[5,0,0,0],[4,0,1,0],[1,0,0,0],[0,1,0,0],[0,0,0,2],[11,0,1,0],[12,0,0,0],
      [12,1,0,0],[12,0,0,2],[13,0,1,0],[12,0,0,0],[11,0,1,0],[8,1,0,0],[8,0,0,2],[7,0,0,0],[5,0,1,0],[4,0,0,0],[5,0,0,0],[7,0,1,0],[8,1,0,0],[7,0,1,0],[4,0,1,0],[1,0,0,0]],
    p: { bpm: 118, res: 0.82, env: 0.6, dec: 0.4, wave: 0, drv: 1, send: 0.2, fb: 0.42, lvl: 0.8, verb: 0.15, drums: 'disco', drone: 1 } },
  { name: 'Deep', zh: 'Deep Acid', en: 'Deep acid', raw: [[0,0,0,0],[0,0,0,2],[7,0,1,0],[12,0,0,0],[0,0,0,1],[10,0,0,0],[10,0,0,2],[0,0,0,1],[3,0,1,0],[7,0,0,0],[7,0,0,2],[0,0,0,1],[12,1,0,0],[10,0,1,0],[7,0,0,0],[0,0,0,1]],
    p: { bpm: 112, res: 0.5, env: 0.35, dec: 1.2, wave: 0, drv: 1, send: 0.3, fb: 0.5, lvl: 0.62, verb: 0.35, drums: 'soft', pad: 1 } },
  { name: 'Techno', zh: 'Acid Techno', en: 'Acid techno', raw: [[0,1,0,0],[0,0,0,0],[12,0,1,0],[0,0,0,0],[0,0,0,0],[12,1,0,0],[0,0,0,0],[15,0,1,0],[0,1,0,0],[0,0,0,0],[12,0,0,0],[10,0,1,0],[0,0,0,0],[12,1,0,0],[3,0,0,0],[0,0,0,0]],
    p: { bpm: 136, res: 0.88, env: 0.62, dec: 0.3, wave: 0, drv: 2.2, send: 0.24, fb: 0.42, lvl: 0.8, verb: 0.12, drums: 'big' } },
  { name: 'Minimal', zh: '极简 Acid', en: 'Minimal acid', raw: [[0,1,0,0],[0,0,0,2],[0,0,0,1],[0,0,0,1],[7,0,1,0],[0,0,0,0],[0,0,0,1],[0,0,0,1],[0,1,0,0],[0,0,0,2],[0,0,0,1],[10,0,1,0],[12,0,0,0],[0,0,0,1],[0,0,0,1],[0,0,0,1]],
    p: { bpm: 126, res: 0.92, env: 0.78, dec: 0.9, wave: 0, drv: 1, send: 0.38, fb: 0.55, lvl: 0.85, verb: 0.3, drums: 'minimal' } },
];
// 连音（2）= 上一步滑过来、音高不变；连打两下 = rat
const toSteps = raw => { const out = []; raw.forEach((x, i) => { const q = { n: x[0], acc: x[1], sl: x[2], rest: x[3] === 1 ? 1 : 0, rat: x[4] || 0 }; if (x[3] === 2 && out[i - 1] && !out[i - 1].rest) { out[i - 1].sl = 1; q.n = out[i - 1].n; } out.push(q); }); return out; };
PRESETS.forEach(P => { P.steps = toSteps(P.raw); });
const NPAT = PRESETS.length;
const PENTA = [-12, -9, -7, -5, -2, 0, 3, 5, 7, 10, 12];   // A 小调五声，下标 -5…5（−/+ 按钮一格一格走）
const KEYTRACK = 0.8;   // 移调（−/+、← →）时 CUTOFF 跟着移 80%：303 原机的截止不跟音高，共振峰停在原地，转调就几乎听不出来

/* ---------------- 状态 ---------------- */
const saved = store.get('lip303-settings', {});
const S = {
  mode: 'free', input: 'none', vowel: !!saved.vowel, drums: false, drumsTouched: false, wave: saved.wave ? 1 : 0, oct: saved.oct || 0,
  lang: Q.get('lang') || saved.lang || 'en',   // 默认英文；开始页右上角可切中文
  camId: saved.camId || '', smooth: saved.smooth != null ? saved.smooth : 0, beauty: Q.get('beauty') != null ? +Q.get('beauty') : saved.beauty != null ? saved.beauty : 1, clean: Q.has('clean'),
  gest: { jaw: true, nod: true, wink: true, brow: true, ...(saved.gest || {}) },
  manTr: 0, pat: 0, dropHold: false, gate: false,
  camOn: false, face: false, lastFaceAt: -1e9, testVideo: Q.get('video'),
  ptr: { down: false, x: 0.5, y: 0.75, id: null },
};
const saveSettings = () => store.set('lip303-settings', { midiOn: MIDI.on, midiPort: MIDI.port, midiCh: MIDI.ch, midiMute: MIDI.mute, camId: S.camId, lang: S.lang, vowel: S.vowel, wave: S.wave, oct: S.oct, smooth: S.smooth, beauty: S.beauty, gest: S.gest });
/* ---------------- MIDI 输出：嘴型 → CC，给 DAW 里任何合成器 / 效果做 MIDI Learn（acid 靠的是参数变化，正好是 CC） ----------------
   映射沿用 GM2 惯例：CC74 = brightness（cutoff），CC71 = resonance；咧嘴给 CC1（mod wheel，多数合成器默认就接），挑眉给 CC91（混响量）。
   重音：CC80 打一下 127，0.12 秒后回 0。只在数值变化时发。 */
const MIDI_MAP = [
  { k: 'open', cc: 74, zh: '张嘴', en: 'Open' }, { k: 'round', cc: 71, zh: '嘟嘴', en: 'Pucker' }, { k: 'wide', cc: 1, zh: '咧嘴', en: 'Smile' },
  { k: 'brow', cc: 91, zh: '挑眉', en: 'Brows' }, { k: 'acc', cc: 80, zh: '重音', en: 'Accent' },
];
const MIDI_UI = Q.has('midi') && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);   // 本地测试中：只在本机 + ?midi 才出现
const MIDI = { access: null, out: null, on: MIDI_UI && !!saved.midiOn, port: saved.midiPort || '', ch: saved.midiCh || 1, mute: saved.midiMute !== false, last: {}, learn: null, learnT: 0, sent: 0 };
const isCam = () => S.input === 'camera' || S.input === 'video';
// 中英文：页面上的元素在 data-i18n 里直接写英文；程序里的字用 L('中文', 'English')
// 英文里的弯引号换成直的：页面字体先用中文字体，弯引号会按全角排（“Can’ t”）
const ascq = t => typeof t === 'string' ? t.replace(/[’‘]/g, "'").replace(/[“”]/g, '"') : t;
const L = (zh, en) => S.lang === 'en' ? ascq(en) : zh;
const FL = (zh, en, neutral) => S.clean ? neutral : L(zh, en);   // 弹出提示：录屏模式里不分语言

// 校准：原始特征的“静止值”和“最大值”
const CAL_DEFAULT = { openRest: 0.03, openMax: 0.42, noise: 0.006, roundRest: 0.05, roundMax: 0.7, wideRest: 0.56, wideMax: 0.68, browRest: 0.08, browMax: 0.55, rollRest: 0, blinkDiff: 0 };
// 校准数据把关：闭嘴时的值太大（校准时嘴其实张着）、抖动太大，都会让“张嘴”一直是 0（2026-10-22 实测：静止 0.48、抖动 0.22）
function sanitizeCal(c) {
  if (!(c.openRest <= 0.12)) c.openRest = CAL_DEFAULT.openRest;
  c.noise = Math.min(0.02, Math.max(0.002, c.noise || CAL_DEFAULT.noise));
  if (!(c.openMax - c.openRest >= 0.12)) c.openMax = Math.max(CAL_DEFAULT.openMax, c.openRest + 0.15);
  return c;
}
let CAL = sanitizeCal({ ...CAL_DEFAULT, ...(store.get('lip303-cal', null) || {}) });
const calStored = () => !!store.get('lip303-cal', null);

/* ---------------- 1€ 滤波（Casiez 2012） ----------------
   导数用“原始样本差分”（用上一帧滤波值求导会把速度算小、显得更迟钝，大提琴项目踩过）。 */
class OneEuro {
  constructor(minCut, beta, dCut = 4) { this.minCut = minCut; this.beta = beta; this.dCut = dCut; this.x = null; this.xr = 0; this.dx = 0; this.t = 0; }
  static a(cut, dt) { const tau = 1 / (6.283185 * cut); return 1 / (1 + tau / dt); }
  f(x, t) {
    if (this.x === null) { this.x = this.xr = x; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    this.dx += OneEuro.a(this.dCut, dt) * ((x - this.xr) / dt - this.dx); this.xr = x;
    this.x += OneEuro.a(this.minCut + this.beta * Math.abs(this.dx), dt) * (x - this.x);
    return this.x;
  }
}
// 参数来自 3 段本地视频的离线回放（见 analysis.md「延迟」）：原始数据静止时只抖 0.4–0.7%（≈ CUTOFF 0.02–0.03 个八度），
// 所以不用压得很重：默认 minCut 5 / beta 4，上升沿只拖约 5 ms（第一版 minCut 1.8 / beta 1.2 拖 14–17 ms）。“稳”那头回到 minCut 1 / beta 1。
const FP = { lead: 0 };   // 预测（按速度往前推）：测下来抖动换延迟不划算，默认关
const fpOpen = () => ({ mc: lerp(5, 1, S.smooth), beta: lerp(4, 1, S.smooth) });
const mkF = () => { const { mc, beta } = fpOpen(); return { open: new OneEuro(mc, beta), round: new OneEuro(mc, beta * 0.5), wide: new OneEuro(mc, beta * 0.5), brow: new OneEuro(mc * 0.5, 1.0), nose: new OneEuro(3.0, 0.5) }; };
let F = mkF();

const R = { open: 0, round: 0, wide: 0, brow: 0, blinkL: 0, blinkR: 0, roll: 0, nose: 0 };   // 原始
const N = { open: 0, round: 0, wide: 0, brow: 0 };   // 归一后的目标（0–1）
const V = { open: 0, openF: 0, round: 0, wide: 0, brow: 0, vOpen: 0, nose: 0, vNose: 0, eye: 0 };   // 滤波后
let lastTick = 0, openHist = [], noseHist = [], lastAccAt = -1e9, winkSince = -1, lastWinkAt = -1e9, closedSince = -1, closedFired = false;
let LM = null;   // Float32Array，x,y 交错，478 点

/* ---------------- 诊断 ---------------- */
class Series {
  constructor(n = 600) { this.n = n; this.v = []; }
  push(x) { if (Number.isFinite(x)) { this.v.push(x); if (this.v.length > this.n) this.v.shift(); } }
  pct(p) { if (!this.v.length) return NaN; const s = [...this.v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }
  snap() { return { n: this.v.length, median: +this.pct(50).toFixed(1), p95: +this.pct(95).toFixed(1) }; }
  clear() { this.v = []; }
}
const D = { inf: new Series(), frameToCtl: new Series(), capToCtl: new Series(), capToDispatch: new Series(), frameWait: new Series(), interval: new Series(),
  vsync: new Series(), stamps: [], backend: '', src: '', warm: 0, frames: 0, faces: 0, cur: '', infBy: { GPU: new Series(), CPU: new Series() } };
// 自动选后端：先用一个（桌面 CPU、手机 GPU），带脸推理 40 帧中位数 > 20 ms 就再试另一个，留快的。?delegate= 可以指定
// （2026-10-22 实测：桌面窗口里 GPU 推理 33 ms、刷新对齐偏差 1 ms = 被屏幕刷新节拍卡住；同一台机器 CPU 14 ms）
const AUTO = { on: !Q.get('delegate') && !Q.has('main'), phase: 0, log: '' };
function autoBackend(d) {
  if (!AUTO.on || !worker) return;
  const s = D.infBy[d];
  if (AUTO.phase === 0 && d === D.cur && s.v.length >= 40) {
    const med = s.pct(50), other = d === 'GPU' ? 'CPU' : 'GPU';
    if (med <= 20) { AUTO.on = false; AUTO.log = d + ' ' + med.toFixed(0) + ' ms，够快'; return; }
    AUTO.phase = 1; AUTO.first = d; AUTO.firstMed = med; AUTO.log = d + ' ' + med.toFixed(0) + ' ms，再试 ' + other + '…'; worker.postMessage({ type: 'add', delegate: other });
  } else if (AUTO.phase === 2 && d === AUTO.trying && s.v.length >= 40) {   // 只看新后端自己的 40 帧（切换那一刻路上还有旧后端的结果）
    const med = s.pct(50), best = med < AUTO.firstMed ? d : AUTO.first;
    D.cur = best; D.backend = best + ' · Worker'; AUTO.phase = 3; AUTO.on = false;
    AUTO.log = `${AUTO.first} ${AUTO.firstMed.toFixed(0)} ms / ${d} ${med.toFixed(0)} ms → 用 ${best}`;
  }
}
function onAdded(m) {
  if (!m.ok) { AUTO.on = false; AUTO.log += '（' + m.backend + ' 建不起来）'; return; }
  D.infBy[m.backend].clear(); AUTO.trying = m.backend; D.cur = m.backend; D.backend = m.backend + ' · Worker'; AUTO.phase = 2;
}
const rate = () => { const now = performance.now(); while (D.stamps.length && now - D.stamps[0] > 2000) D.stamps.shift(); return D.stamps.length < 2 ? 0 : (D.stamps.length - 1) * 1000 / Math.max(1, now - D.stamps[0]); };
const TRACE = [];   // 最近 90 秒：每帧 {t, raw, out, ms}，导出和离线调参用
const pushTrace = o => { TRACE.push(o); while (TRACE.length > 2700) TRACE.shift(); };

/* ---------------- 声音 ---------------- */
const A = { ctx: null, node: null, p: null, tel: { fc: 300, cut: 300, res: 0.55, env: 0.5, m: 45, a: 0, step: -1, pat: 0, sw: 0, f2: 1500, a2: 0, send: 0.1 } };
function transpose() { return PENTA[Math.max(-5, Math.min(5, S.manTr)) + 5]; }
const rootNote = () => (S.mode === 'seq' ? 33 : 45) + 12 * S.oct;
function synthParams() {
  const o = V.open, r = V.round, w = V.wide, b = S.gest.brow ? V.brow : 0, pre = PRESETS[S.pat].p, seq = S.mode === 'seq';
  // 两个峰：第一个峰收窄到 220–1100 Hz（更像说话的 F1），第二个峰随嘴宽 / 嘴圆在 0.8–2.3 kHz 之间移动
  const cut = (S.vowel ? 220 * Math.pow(1100 / 220, o) : 150 * Math.pow(2500 / 150, o)) * Math.pow(2, KEYTRACK * transpose() / 12);
  const rb = seq ? Math.max(0.3, pre.res - 0.25) : 0.48, eb = seq ? clamp01(pre.env - 0.15) : 0.25;
  const env = Math.min(1, eb + 0.5 * w);
  return {
    mode: S.mode, cut, res: Math.min(0.97, rb + (0.97 - rb) * r), env: S.vowel ? Math.min(env, 0.35) : env,
    f2: 1150 * Math.pow(2, 1.0 * w - 0.55 * r), f2amt: S.vowel ? 0.25 + 0.75 * w : 0,
    verbAdd: b, verbHold: S.dropHold ? 1 : 0,   // 挑眉多少 = 空间多少（混响 + 延迟，见 worklet.js） tr: transpose(), root: rootNote(),
    gate: S.gate ? 1 : 0, lvl: S.mode === 'free' ? 0.7 + 0.3 * o : 1, drums: S.drums ? 1 : 0, wave: S.wave, vol: 1,
  };
}
function push() { if (A.node) A.node.port.postMessage({ type: 'p', p: synthParams() }); midiTick(); }
function initAudio() { if (!A.p) A.p = makeAudio(); return A.p.then(() => { if (A.ctx.state !== 'running') return A.ctx.resume(); }); }
// 干声 → 高通 25 Hz → 压缩 → 限幅；混响送入 → 卷积混响（1.8 秒，程序生成）→ 压缩。照“Acid 的八种玩法”的链路
function buildChain(ctx, node, dest) {
  const n = Math.floor(ctx.sampleRate * 1.8), ir = ctx.createBuffer(2, n, ctx.sampleRate);
  let seed = 303; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / n, 3); }
  const rev = ctx.createConvolver(); rev.buffer = ir; const wet = ctx.createGain(); wet.gain.value = 0.45;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 25;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 2.5; comp.knee.value = 6; comp.attack.value = 0.004; comp.release.value = 0.15;
  const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -2.5; lim.ratio.value = 20; lim.knee.value = 0; lim.attack.value = 0.001; lim.release.value = 0.08;
  const out = ctx.createGain(); out.gain.value = 0.8;
  node.connect(hp, 0); hp.connect(comp); node.connect(rev, 1); rev.connect(wet); wet.connect(comp); comp.connect(lim); lim.connect(out); out.connect(dest);
  return out;
}
const procOpts = extra => ({ numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2], processorOptions: { presets: PRESETS.map(P => ({ steps: P.steps, p: P.p })), ...extra } });
async function makeAudio() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('worklet.js?v=6');
  const node = new AudioWorkletNode(ctx, 'lip303', procOpts({ init: synthParams() }));
  A.out = buildChain(ctx, node, ctx.destination); midiMuteApply();
  node.port.onmessage = e => { A.tel = e.data; };
  A.ctx = ctx; A.node = node;
}

/* ---------------- 识别：Worker 优先，不行就在主线程跑 ---------------- */
let recDone = false, worker = null, mainLM = null, recReady = null, stream = null, busy = false, lastFrame = -1, fid = 0, latest = { frame: -1, now: 0 };
const inflight = new Map();
function initRecognizer() {
  if (recReady) return recReady;
  recReady = (async () => {
    if (!Q.has('main') && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try { await initWorker(await preload()); return; } catch (e) { console.warn('[06] Worker 识别没起来，改在主线程跑：', e); if (worker) worker.terminate(); worker = null; }
    }
    await initMain();
  })();
  recReady.then(() => { recDone = true; recFail = null; }, e => { recReady = null; recFail = e; });
  return recReady;
}
function initWorker(pre) {
  return new Promise((resolve, reject) => {
    worker = new Worker('face-worker.js?v=4');
    const to = setTimeout(() => reject(new Error('Worker 加载超时')), 90000);
    worker.onerror = e => { clearTimeout(to); reject(new Error(e.message || 'worker error')); };
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') { clearTimeout(to); D.cur = data.backend; D.backend = data.backend + ' · Worker'; D.src = data.src; D.warm = data.warm; resolve();
        if (data.backend === 'CPU' && data.warm > 600) toast(L('人脸识别跑得很慢。', 'Face tracking is running very slowly. ') + edgeTip()); }   // 正常 CPU 预热 ≈ 60 ms
      else if (data.type === 'result') onResult(data.id, data.pts, data.bs, data.inference, data.d);
      else if (data.type === 'added') onAdded(data);
      else if (data.type === 'error') { if (data.id != null) { busy = false; inflight.delete(data.id); } else { clearTimeout(to); reject(new Error(data.message)); } console.warn('[06]', data.message); }
    };
    const delegates = Q.get('delegate') ? [Q.get('delegate').toUpperCase()] : isMobile ? ['GPU', 'CPU'] : ['CPU', 'GPU'];
    // pre：已经下好的 wasm（blob 地址）和模型（ArrayBuffer，直接转给 Worker）；没有就让 Worker 自己按地址下
    const p = pre ? { js: pre.src.js, name: pre.src.name, loader: pre.src.wasm + '/vision_wasm_internal.js', bin: pre.bin, model: pre.model } : null;
    worker.postMessage({ type: 'init', srcs: mpSources(), delegates, pre: p }, p ? [p.model] : []);
  });
}
async function initMain() {
  if (typeof window.dbg !== 'function') window.dbg = () => {};   // 同 face-worker.js
  let err;
  for (const s of mpSources()) {
    try {
      const mp = await import(s.js), fs = await mp.FilesetResolver.forVisionTasks(s.wasm);
      for (const delegate of Q.get('delegate') === 'CPU' ? ['CPU'] : ['GPU', 'CPU']) {
        try {
          mainLM = await mp.FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: s.model, delegate }, runningMode: 'VIDEO', numFaces: 1,
            outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
          const c = document.createElement('canvas'); c.width = 64; c.height = 48; c.getContext('2d').fillRect(0, 0, 64, 48);
          const t0 = performance.now(); mainLM.detectForVideo(c, t0); D.warm = performance.now() - t0;
          D.backend = delegate + ' · 主线程'; D.src = s.name; return;
        } catch (e) { err = e; try { if (mainLM) mainLM.close(); } catch (_) {} mainLM = null; }
      }
    } catch (e) { err = e; }
  }
  throw err || new Error('load failed');
}

async function startCamera() {
  if (S.testVideo) return startVideoFile(S.testVideo);
  $('#camerr').hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camErr(L('这个浏览器拿不到摄像头', 'This browser can’t open the camera'), L('需要 https 和较新的浏览器（Chrome / Edge / Safari）。', 'It needs https and a recent browser (Chrome / Edge / Safari).')); return; }
  setStatus('wait', L('打开摄像头…', 'Opening camera…'));
  let err = null;
  try { stream = await openStream(S.camId); } catch (e) { err = e; }
  if (!stream && S.camId) { try { stream = await openStream(''); err = null; } catch (e) { err = e; } }   // 上次选的摄像头拔掉了
  if (!stream) { camErrFor(err); return; }
  // 默认给的是虚拟摄像头（Iriun / OBS 之类，软件没开就只有一张提示图）而且还有别的摄像头：换成真的那个（Edge 上实际遇到）
  const t0 = stream.getVideoTracks()[0];
  if (!S.camId && t0 && VIRT.test(t0.label)) {
    const real = (await listCams()).find(c => c.label && !VIRT.test(c.label));
    if (real) { try { const s2 = await openStream(real.deviceId); stream.getTracks().forEach(t => t.stop()); stream = s2; } catch (e) {} }
  }
  video.srcObject = stream; fillCamPicker();
  try { await video.play(); } catch (e) {}
  await startSource('camera');
}
const VIRT = /iriun|obs|virtual|droidcam|snap camera|manycam|xsplit|epoccam|ndi|\bcamo\b|broadcast|vcam|byom/i;
function openStream(id) {
  const v = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: isMobile ? 30 : 60 } };
  if (id) v.deviceId = { exact: id }; else v.facingMode = 'user';
  return navigator.mediaDevices.getUserMedia({ audio: false, video: v });
}
async function listCams() { try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch (e) { return []; } }
async function fillCamPicker() {
  const cams = await listCams(), tr = stream && stream.getVideoTracks()[0], cur = tr && tr.getSettings().deviceId;
  const sel = $('#cam-s'), name = (c, i) => c.label || L('摄像头 ', 'Camera ') + (i + 1);
  sel.replaceChildren(...cams.map((c, i) => { const o = document.createElement('option'); o.value = c.deviceId; o.textContent = name(c, i); return o; }));
  if (cur) sel.value = cur;
  // 画面左上角的小摄像头图标：点开是摄像头列表
  const hd = document.createElement('small'); hd.textContent = L('选择摄像头', 'CAMERA');
  $('#cam-menu').replaceChildren(hd, ...cams.map((c, i) => { const b = document.createElement('button'); b.textContent = name(c, i); b.setAttribute('aria-current', c.deviceId === cur);
    b.onclick = () => { $('#cam-menu').hidden = true; if (c.deviceId !== cur) switchCam(c.deviceId); }; return b; }));
  $('#cam-pick').hidden = cams.length < 2;
  $('#campick').hidden = !cams.length || !stream;
}
async function switchCam(id) {
  S.camId = id; saveSettings();
  if (!stream) return;
  try { const s2 = await openStream(id); stream.getTracks().forEach(t => t.stop()); stream = s2; video.srcObject = s2; try { await video.play(); } catch (e) {} S.camAt = performance.now() / 1000; S.facesAt = D.faces; camDarkSince = -1; fillCamPicker(); }
  catch (e) { toast(L('这个摄像头打不开：', 'Can’t open this camera: ') + e.name); fillCamPicker(); }
}
async function startVideoFile(url) {
  video.srcObject = null; video.setAttribute('muted', ''); video.muted = true; video.loop = true; video.src = url;
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) { try { await video.play(); ok = true; } catch (e) { if (e.name === 'NotSupportedError') break; await new Promise(r => setTimeout(r, 400)); } }
  if (!ok) { fallback(L('测试视频放不了：', 'Can’t play test video: ') + url); return; }
  $('#testvid').hidden = false;
  await startSource('video');
}
async function startSource(kind) {
  S.camLoading = true; video.classList.add('on');
  setStatus('wait', L('加载识别模型…', 'Loading face model…'));
  try { await initRecognizer(); } catch (e) { console.warn(e); S.camLoading = false; stopCamera();
    camErr(L('识别模型没加载上', 'Face model didn’t load'), (IS_EDGE ? edgeTip() : L('多半是网络问题，再试一次；还不行就换 Chrome。', 'Probably the network. Try again; if it still fails, try Chrome.'))); return; }
  S.camLoading = false; S.camOn = true; S.camAt = performance.now() / 1000; S.facesAt = D.faces; S.input = kind; $('#cam-btn').textContent = L('关闭摄像头', 'Camera off'); applyBeauty();
  lastFrame = -1; latest = { frame: -1, now: 0 }; busy = false; inflight.clear();
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onVFrame); else requestAnimationFrame(pollFrame);
  setStatus('wait', L('找脸…', 'Looking for a face…'));
  if (kind === 'camera' && !calStored()) startCalib();
  else if (kind === 'camera') toast(L('用上次的校准。换了人或位置，点“重新校准”', 'Using your last calibration. New person or spot? Recalibrate in ⚙.'));
  if (BENCH) startBench();
}
function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; $('#campick').hidden = true;
  video.srcObject = null; video.removeAttribute('src'); video.load(); video.classList.remove('on'); $('#testvid').hidden = true;
  applyBeauty();
  S.camOn = false; S.camLoading = false; S.face = false; LM = null; S.input = 'pointer'; $('#cam-btn').textContent = L('打开摄像头', 'Camera on'); endCalib();
}
function fallback(msg) { S.input = 'pointer'; toast(msg); }
function camErr(title, detail) {
  S.input = 'pointer'; setStatus('', L('鼠标 / 手指', 'Mouse / touch'));
  $('#camerr-t').textContent = title; $('#camerr-d').textContent = detail; $('#camerr').hidden = false;
}
function camErrFor(e) {
  const n = e && e.name;
  if (INAPP) return camErr(L('这个 App 里打不开摄像头', 'The camera is blocked in this app'),
    L('点右上角 ⋯ → 在浏览器中打开（Chrome / Safari），就能正常用了。', 'Tap ⋯ → Open in browser (Chrome / Safari) and it will work.'));
  if (n === 'NotAllowedError' || n === 'SecurityError') return camErr(L('摄像头被拒绝了', 'Camera access blocked'),
    L('点地址栏里的摄像头 / 锁图标 → 允许使用摄像头，再点“再试一次”。', 'Click the camera or lock icon in the address bar → allow the camera, then Try again.'));
  if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') return camErr(L('摄像头被别的软件占着', 'Camera is busy'),
    L('Zoom、Teams、OBS、微信之类可能正在用摄像头。关掉它们，再点“再试一次”。', 'Another app (Zoom, Teams, OBS…) may be using it. Close it, then Try again.'));
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return camErr(L('没找到摄像头', 'No camera found'),
    L('插上摄像头再点“再试一次”，或者先用鼠标 / 手指玩。', 'Plug one in and Try again, or play with mouse / touch.'));
  camErr(L('摄像头打不开', 'Can’t open the camera'), (n ? '(' + n + ') ' : '') + L('再试一次；还不行就换 Chrome。', 'Try again; if it still fails, try Chrome.'));
}
// 新帧：rVFC 的 presentedFrames（一帧只识别一次）
// 新帧用摄像头的采集时间认（文件用 mediaTime）：高刷屏上同一帧可能被呈现好几次，presentedFrames 会跟着加（实测帧间隔中位 8.2 ms）
function onVFrame(now, meta) {
  if (!S.camOn) return;
  video.requestVideoFrameCallback(onVFrame);
  const key = meta.captureTime || meta.mediaTime || meta.presentedFrames;
  if (key === latest.key) return;
  if (latest.now) D.interval.push(now - latest.now);
  latest = { now, cap: meta.captureTime, frame: meta.presentedFrames, key };
  dispatch();
}
let pollN = 0;
function pollFrame(now) {   // 没有 rVFC 的浏览器：每 ~33 ms 当一帧
  if (!S.camOn) return;
  if (now - latest.now >= 32) { if (latest.now) D.interval.push(now - latest.now); latest = { now, frame: ++pollN }; dispatch(); }
  requestAnimationFrame(pollFrame);
}
function dispatch() {
  if (!S.camOn || busy || latest.frame === lastFrame || video.readyState < 2 || !video.videoWidth) return;
  lastFrame = latest.frame; busy = true;
  const id = ++fid, at = performance.now();
  inflight.set(id, { at, frameAt: latest.now, cap: latest.cap });
  D.frameWait.push(at - latest.now); if (latest.cap) D.capToDispatch.push(at - latest.cap);
  if (worker) {
    const vw = video.videoWidth, vh = video.videoHeight, sc = Math.min(1, 640 / vw);   // 大于 640 宽的视频先缩小，跟摄像头一样大
    const opt = sc < 1 ? { resizeWidth: Math.round(vw * sc), resizeHeight: Math.round(vh * sc), resizeQuality: 'low' } : undefined;
    createImageBitmap(video, opt).then(bm => {
      if (!S.camOn || !worker) { bm.close(); busy = false; return; }
      worker.postMessage({ type: 'frame', bitmap: bm, ts: at, id, d: D.cur }, [bm]);
    }).catch(e => { busy = false; inflight.delete(id); console.warn(e); });
  } else if (mainLM) {
    const t0 = performance.now(); let r = null;
    try { r = mainLM.detectForVideo(video, at); } catch (e) { console.warn(e); }
    const inf = performance.now() - t0, lm = r && r.faceLandmarks && r.faceLandmarks[0];
    let pts = null; const bs = {};
    if (lm) { pts = new Float32Array(lm.length * 2); lm.forEach((p, i) => { pts[2 * i] = p.x; pts[2 * i + 1] = p.y; });
      const cats = r.faceBlendshapes && r.faceBlendshapes[0] && r.faceBlendshapes[0].categories; if (cats) cats.forEach(c => { bs[c.categoryName] = c.score; }); }
    onResult(id, pts, bs, inf);
  } else busy = false;
}
function onResult(id, pts, bs, inference, d) {
  const m = inflight.get(id); inflight.delete(id); busy = false;
  const now = performance.now();
  D.inf.push(inference); D.stamps.push(now); D.frames++; S.infAvg = S.infAvg ? S.infAvg * 0.95 + inference * 0.05 : inference;
  if (pts && d) { D.infBy[d].push(inference); autoBackend(d); }
  D.vsync.push(Math.abs(inference - Math.round(inference / 16.667) * 16.667));   // ≲1.5 ms：推理被屏幕刷新节拍卡住
  onFace(pts, bs || {}, (m ? m.frameAt : now) / 1000);
  const written = performance.now();
  if (m) { D.frameToCtl.push(written - m.frameAt); if (m.cap) D.capToCtl.push(written - m.cap); }
  if (pts) pushTrace({ t: +((m ? m.frameAt : now) / 1000).toFixed(4), ro: +R.open.toFixed(4), raw: +N.open.toFixed(4), out: +V.open.toFixed(4), ms: m ? +(written - m.frameAt).toFixed(1) : null });
  dispatch();   // 这期间又来了新帧：立刻接着识别
}
function dist(a, b, vw, vh) { return Math.hypot((LM[2 * a] - LM[2 * b]) * vw, (LM[2 * a + 1] - LM[2 * b + 1]) * vh); }
function onFace(pts, bs, t) {
  if (!pts) { S.face = false; LM = null; if (beautyOn()) BV.setMask(null); return; }
  LM = pts; S.face = true; if (beautyOn()) BV.setMask(LM); S.lastFaceAt = performance.now() / 1000; D.faces++;
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const iod = dist(33, 263, vw, vh) || 1;
  R.open = dist(13, 14, vw, vh) / iod;          // 内唇上下距离 ÷ 两眼外角距离
  R.wide = dist(61, 291, vw, vh) / iod;         // 嘴角距离 ÷ 两眼外角距离
  R.roll = Math.atan2((LM[67] - LM[527]) * vh, (LM[526] - LM[66]) * vw) * 180 / Math.PI;   // 33 / 263 号点；镜像里头歪向屏幕右边 = 正
  R.nose = (LM[3] - (LM[67] + LM[527]) / 2) * vh / iod;
  const b = n => bs[n] || 0;
  R.round = Math.max(b('mouthPucker'), b('mouthFunnel'));
  R.brow = Math.max(b('browInnerUp'), (b('browOuterUpLeft') + b('browOuterUpRight')) / 2);
  R.blinkL = b('eyeBlinkLeft'); R.blinkR = b('eyeBlinkRight');
  if (CAL_RUN) calSample();
  normFromCam();
  tick(t);
}
function normFromCam() {
  const C = CAL;
  if (!CAL_RUN) {   // 张得比校准时还大：上限跟着慢慢走；闭得比校准时还紧：静止值往下跟
    if (R.open > C.openMax) C.openMax += (R.open - C.openMax) * 0.15;
    if (R.open < C.openRest) C.openRest += (R.open - C.openRest) * 0.1;
    if (R.round > C.roundMax) C.roundMax += (R.round - C.roundMax) * 0.15;
    if (R.wide > C.wideMax) C.wideMax += (R.wide - C.wideMax) * 0.15;
  }
  const dz = Math.min(0.04, Math.max(0.012, 2.5 * C.noise));
  N.open = clamp01((R.open - C.openRest - dz) / Math.max(0.05, C.openMax - C.openRest - dz));
  N.round = clamp01((R.round - C.roundRest - 0.04) / Math.max(0.1, C.roundMax - C.roundRest - 0.04));
  N.wide = clamp01((R.wide - C.wideRest - 0.01) / Math.max(0.03, C.wideMax - C.wideRest - 0.01));
  N.brow = clamp01((R.brow - C.browRest - 0.05) / Math.max(0.1, C.browMax - C.browRest - 0.05));
  N.brow = clamp01(N.brow - 0.35 * N.open);   // 张大嘴时眉毛常跟着抬：扣掉一点，免得误触 DROP
}

/* ---------------- 每次有新数据：滤波 + 动作识别 + 发给声音 ---------------- */
function tick(t) {
  lastTick = t;
  const prevOpen = V.open;
  V.openF = F.open.f(N.open, t);
  V.open = clamp01(V.openF + FP.lead * F.open.dx);
  V.round = F.round.f(N.round, t); V.wide = F.wide.f(N.wide, t); V.brow = F.brow.f(N.brow, t);
  openHist.push([t, V.open]); while (openHist.length > 3) openHist.shift();
  V.vOpen = openHist.length > 1 ? (V.open - openHist[0][1]) / Math.max(0.016, t - openHist[0][0]) : 0;
  const camLive = isCam() && S.face;
  if (S.gest.jaw && V.vOpen > 3.2 && V.open > 0.22 && prevOpen < V.open && t - lastAccAt > 0.22) accent('jaw');
  if (camLive) {
    V.nose = F.nose.f(R.nose, t); noseHist.push([t, V.nose]); while (noseHist.length > 3) noseHist.shift();
    V.vNose = noseHist.length > 1 ? (V.nose - noseHist[0][1]) / Math.max(0.016, t - noseHist[0][0]) : 0;
    if (S.gest.nod && V.vNose > 0.9 && t - lastAccAt > 0.3) accent('nod');
    // 换音型：单眼眨（一只闭、一只开，保持 120 ms），或者双眼闭上 0.6 秒（正常眨眼只有 0.1–0.4 秒）
    const bl = R.blinkL, br = R.blinkR, d = (bl - br) - CAL.blinkDiff;
    const wink = Math.abs(d) > 0.25 && Math.max(bl, br) > 0.45 && Math.min(bl, br) < 0.4, both = Math.min(bl, br) > 0.55;
    if (wink) { if (winkSince < 0) winkSince = t; else if (S.gest.wink && t - winkSince > 0.12 && t - lastWinkAt > 0.8) { lastWinkAt = t; nextPattern(1); } } else winkSince = -1;
    if (both) { if (closedSince < 0) closedSince = t; else if (S.gest.wink && !closedFired && t - closedSince > 0.6 && t - lastWinkAt > 0.8) { closedFired = true; lastWinkAt = t; nextPattern(1); } } else { closedSince = -1; closedFired = false; }
    V.eye = Math.max(clamp01((Math.abs(d) - 0.05) / 0.25), both && closedSince >= 0 ? clamp01((t - closedSince) / 0.6) : 0);
  }
  // 门（自由说话）：摄像头 = 张嘴超过一点就出声（滞回）；鼠标 / 手指 = 按下出声
  if (S.mode === 'free') {
    if (camLive) S.gate = S.gate ? V.open > 0.05 : V.open > 0.11;
    else if (isCam() && !ptrActive()) { if (performance.now() / 1000 - S.lastFaceAt >= 0.3) S.gate = false; }   // 跟丢脸：先保持 0.3 秒
    else S.gate = S.ptr.down;
  }
  push();
}
function accent(src) { midiAccent(); initAudio(); if (A.node) A.node.port.postMessage({ type: 'acc' }); lastAccAt = lastTick || performance.now() / 1000; hit('g-acc'); flash(src === 'nod' ? FL('点头 · 重音', 'Nod · accent', 'ACCENT') : FL('重音', 'Accent', 'ACCENT'), 'acc'); }
function setPattern(i) {
  S.pat = (i + NPAT) % NPAT; if (A.node) A.node.port.postMessage({ type: 'pat', i: S.pat });
  document.querySelectorAll('#pats button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.p === S.pat));
  push(); flash(FL(PRESETS[S.pat].zh + '（下一小节）', PRESETS[S.pat].en + ' (next bar)', PRESETS[S.pat].name.toUpperCase()));
}
function setWave(w) { S.wave = w; $('#w-saw').setAttribute('aria-pressed', !w); $('#w-sq').setAttribute('aria-pressed', !!w); push(); saveSettings(); }
function nextPattern(dir = 1) {
  hit('g-wink');
  if (S.mode === 'seq') setPattern(S.pat + dir);
  else { setWave(S.wave ? 0 : 1); flash(S.wave ? FL('方波', 'Square', 'SQUARE') : FL('锯齿波', 'Saw', 'SAW')); }
}

/* ---------------- 校准（盖在声音区上，左边能看到自己） ---------------- */
const ICON = {
  rest: '<path d="M8 24 C18 16 46 16 56 24 C46 32 18 32 8 24 Z" fill="#FFFDF7" stroke="#1f2328" stroke-width="2.5"/><path d="M12 24 H52" stroke="#1f2328" stroke-width="2.5"/>',
  open: '<path d="M6 24 C16 6 48 6 58 24 C48 46 16 46 6 24 Z" fill="#FFFDF7" stroke="#1f2328" stroke-width="2.5"/><ellipse cx="32" cy="25" rx="16" ry="12" fill="#F2B42C" stroke="#1f2328" stroke-width="2.5"/>',
  round: '<path d="M18 24 C20 10 44 10 46 24 C44 38 20 38 18 24 Z" fill="#FFFDF7" stroke="#1f2328" stroke-width="2.5"/><circle cx="32" cy="24" r="6" fill="#F2B42C" stroke="#1f2328" stroke-width="2.5"/>',
  wide: '<path d="M2 22 C16 12 48 12 62 22 C48 34 16 34 2 22 Z" fill="#FFFDF7" stroke="#1f2328" stroke-width="2.5"/><ellipse cx="32" cy="23" rx="22" ry="4" fill="#F2B42C" stroke="#1f2328" stroke-width="2.5"/>',
};
const CAL_STEPS = [
  { k: 'rest', h: ['闭上嘴，放松', 'Close your mouth, relax'], s: ['先别说话，头摆正', 'Stay quiet, head straight'], dur: 2.8, m: 'open', ml: ['现在张开', 'Open now'] },
  { k: 'open', h: ['嘴张到最大，说“啊”', 'Open wide, say “ah”'], s: ['能张多大张多大，保持 2 秒', 'As wide as you can, hold for 2 s'], dur: 2.0, m: 'open', ml: ['现在张开', 'Open now'] },
  { k: 'round', h: ['嘟起嘴，说“呜”', 'Pucker, say “oo”'], s: ['嘴唇往前收圆', 'Round your lips forward'], dur: 1.8, m: 'round', ml: ['现在嘟嘴', 'Pucker now'] },
  { k: 'wide', h: ['咧开嘴，说“咿”', 'Smile wide, say “ee”'], s: ['嘴角往两边拉', 'Pull the corners out'], dur: 1.8, m: 'wide', ml: ['现在嘴宽', 'Width now'] },
];
let CAL_RUN = null;
function startCalib() {
  if (!isCam()) { toast(L('先打开摄像头再校准', 'Turn the camera on first')); return; }
  CAL_RUN = { i: 0, t: 0, last: performance.now(), sm: [], out: { ...CAL }, retry: 0, msgUntil: 0 };
  $('#calib').hidden = false; showCalStep();
}
function showCalStep() {
  const r = CAL_RUN, st = CAL_STEPS[r.i];
  $('#cal-h').textContent = L(...st.h); $('#cal-s').textContent = L(...st.s); $('#cal-n').textContent = (r.i + 1) + ' / 4'; $('#cal-ml').textContent = L(...st.ml);
  $('#cal-icon').innerHTML = ICON[st.k];
  document.querySelectorAll('#cal-steps i').forEach((el, j) => { el.classList.toggle('done', j < r.i); el.firstChild.style.width = '0%'; });
  $('#cal-back').disabled = r.i === 0;
}
function calSample() {
  const r = CAL_RUN, now = performance.now(), dt = (now - r.last) / 1000; r.last = now;
  r.t += Math.min(dt, 0.1);
  const st = CAL_STEPS[r.i];
  if (r.t > (st.k === 'rest' ? 1.0 : 0.6)) r.sm.push({ ...R });   // 前一小段不算：给人反应时间
  document.querySelectorAll('#cal-steps i')[r.i].firstChild.style.width = (100 * Math.min(1, r.t / st.dur)) + '%';
  if (now > r.msgUntil) $('#cal-s').textContent = L(...st.s);
  const redo = msg => { r.retry++; r.t = 0; r.sm = []; r.msgUntil = now + 2000; $('#cal-s').textContent = msg; };
  const mv = R[st.m]; $('#cal-mv').textContent = mv.toFixed(2);
  const lo = st.m === 'wide' ? 0.45 : 0, hi = st.m === 'open' ? 0.5 : st.m === 'round' ? 1 : 0.8;
  $('#cal-mb').style.width = (100 * clamp01((mv - lo) / (hi - lo))) + '%';
  if (r.t >= st.dur) {
    const col = k => r.sm.map(s => s[k]).sort((a, b) => a - b), med = a => a[a.length >> 1] || 0, p90 = a => a[Math.floor(a.length * 0.9)] || 0;
    const o = r.out;
    if (st.k === 'rest') {
      const op = col('open'), rest = op[Math.floor(op.length * 0.2)] || 0;
      if (rest > 0.12 && r.retry < 2) { redo(L('嘴好像没闭上：闭上嘴，先别说话', 'Your mouth looks open — close it and stay quiet')); return; }
      // 抖动用相邻两帧差的中位数估（说一两个字也不会把它撑大）
      const df = []; for (let i = 1; i < r.sm.length; i++) df.push(Math.abs(r.sm[i].open - r.sm[i - 1].open)); df.sort((a, b) => a - b);
      o.openRest = Math.min(rest, 0.12); o.noise = (df[df.length >> 1] || 0) * 1.4826 / Math.SQRT2;
      o.roundRest = med(col('round')); o.wideRest = med(col('wide')); o.browRest = med(col('brow')); o.rollRest = med(col('roll'));
      o.blinkDiff = med(r.sm.map(s => s.blinkL - s.blinkR).sort((a, b) => a - b));
    } else if (st.k === 'open') {
      const mx = p90(col('open'));
      if (mx - o.openRest < 0.12 && r.retry < 2) { redo(L('再张大一点，像打哈欠那样', 'Wider — like a yawn')); return; }
      o.openMax = Math.max(o.openRest + 0.15, mx);
    }
    else if (st.k === 'round') o.roundMax = Math.max(o.roundRest + 0.15, p90(col('round')));
    else if (st.k === 'wide') o.wideMax = Math.max(o.wideRest + 0.04, p90(col('wide')));
    r.i++; r.t = 0; r.sm = []; r.retry = 0;
    if (r.i >= CAL_STEPS.length) { o.browMax = Math.max(o.browRest + 0.3, CAL_DEFAULT.browMax); CAL = sanitizeCal(o); store.set('lip303-cal', CAL); endCalib(); toast(L('校准好了。张嘴试试', 'Calibrated. Open your mouth.')); }
    else showCalStep();
  }
}
function calIdle() { if (CAL_RUN && !S.face) { CAL_RUN.last = performance.now(); $('#cal-s').textContent = L('看不到脸：把脸放进画面里', 'Can’t see your face — move into the frame'); } }
function endCalib() { CAL_RUN = null; $('#calib').hidden = true; }
$('#cal-back').onclick = () => { if (CAL_RUN && CAL_RUN.i > 0) { CAL_RUN.i--; CAL_RUN.t = 0; CAL_RUN.sm = []; showCalStep(); } };
$('#cal-skip').onclick = () => { endCalib(); toast(L('用默认值。觉得不跟嘴，再点“重新校准”', 'Using defaults. If it feels off, recalibrate in ⚙.')); };

/* ---------------- 鼠标 / 触屏（在镜子里按住拖） ---------------- */
const ptrActive = () => S.input === 'pointer' || S.input === 'none' || (isCam() && !S.face && performance.now() / 1000 - S.lastFaceAt > 1.5);
function ptrSet(e) {
  const r = mirror.getBoundingClientRect(), x = clamp01((e.clientX - r.left) / r.width), y = clamp01((e.clientY - r.top) / r.height);
  S.ptr.x = x; S.ptr.y = y;
  N.open = clamp01((0.88 - y) / 0.72); N.round = clamp01((0.5 - x) * 2.2); N.wide = clamp01((x - 0.5) * 2.2); N.brow = 0;
}
mirror.addEventListener('pointerdown', e => {
  if (!ptrActive() || CAL_RUN) return;
  initAudio(); if (S.input === 'none') S.input = 'pointer';
  S.ptr.down = true; S.ptr.id = e.pointerId; ptrSet(e); tick(performance.now() / 1000);
  try { mirror.setPointerCapture(e.pointerId); } catch (err) {}
});
mirror.addEventListener('pointermove', e => { if (S.ptr.down && e.pointerId === S.ptr.id) ptrSet(e); });
const ptrUp = e => { if (e.pointerId === S.ptr.id) { S.ptr.down = false; S.ptr.id = null; tick(performance.now() / 1000); } };
mirror.addEventListener('pointerup', ptrUp); mirror.addEventListener('pointercancel', ptrUp);

/* ---------------- 美颜（beauty.js，WebGL）：只处理脸上的皮肤 ----------------
   皮肤蒙版来自识别已有的人脸关键点（抠掉眼睛、眉毛、嘴唇）；保边磨皮 + 留一点纹理 + 轻微提亮红润。背景、头发、眼镜不动，不下载任何模型。
   只改看得见的画面，识别用的还是原始帧。 */
const BV = createBeauty($('#bv'));
const BEAUTY = [
  { name: '关' },
  { name: '轻', strength: 0.6, radius: 4.5, detail: 0.35, bright: 0.04, warm: 0.008 },
  { name: '中', strength: 0.9, radius: 6.5, detail: 0.2, bright: 0.07, warm: 0.015 },
];
const beautyOn = () => !!BV && S.camOn && S.beauty > 0;
function applyBeauty() {
  const B = BEAUTY[S.beauty] || BEAUTY[0], on = beautyOn();
  $('#bv').hidden = !on; video.style.filter = 'saturate(.95)';
  if (on) BV.setMask(S.face ? LM : null);
  $('#beauty-s').value = String(S.beauty);
  if (!BV) $('#beauty-s').disabled = true;
}
function drawBeauty() {
  if (!beautyOn()) return;
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480, s = Math.max(MW / vw, MH / vh), dx = (MW - vw * s) / 2, dy = (MH - vh * s) / 2;
  BV.render(video, { kx: MW / (vw * s), ox: -dx / (vw * s), ky: MH / (vh * s), oy: -dy / (vh * s) }, BEAUTY[S.beauty]);
}
function setBeauty(l) { S.beauty = (l + 3) % 3; applyBeauty(); saveSettings(); }
$('#beauty-s').onchange = e => setBeauty(+e.target.value);

/* ---------------- 界面 ---------------- */
let toastT = 0;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 3400); }
function flash(text, cls) {
  const box = $('#flash'), el = document.createElement('span'); el.textContent = text; if (cls) el.className = cls;
  box.appendChild(el); while (box.children.length > 3) box.firstChild.remove(); setTimeout(() => el.remove(), 1150);
}
const hitT = {};
function hit(id, hold) { const el = $('#' + id); if (!el) return; el.classList.add('hit'); clearTimeout(hitT[id]); hitT[id] = setTimeout(() => el.classList.remove('hit'), hold ? 120 : 380); }
function setStatus(kind, txt) { const d = $('#st-dot'); d.className = 'stdot ' + (kind || ''); if (d.title !== txt) d.title = txt; setTxt('st-txt', txt); }
function setMode(m) {
  S.mode = m; document.body.classList.toggle('seq', m === 'seq'); $('#m-free').setAttribute('aria-pressed', m === 'free'); $('#m-seq').setAttribute('aria-pressed', m === 'seq');
  if (!S.drumsTouched) S.drums = m === 'seq';
  $('#drums').setAttribute('aria-pressed', S.drums); S.gate = false;
  $('#pats').hidden = m !== 'seq'; $('#wavegrp').hidden = m === 'seq'; $('#g-wink-b').textContent = m === 'seq' ? L('换音型', 'Pattern') : L('换波形', 'Wave');
  push(); flash(m === 'seq' ? FL('跟律动：用嘴拧滤波', 'Groove: play the filter with your mouth', 'GROOVE') : FL('自由说话：张嘴出声', 'Free talk: open your mouth to play', 'FREE'));
}
function setVowel(v) { S.vowel = v; $('#vowel').setAttribute('aria-pressed', v); $('#p-env-l').textContent = v ? 'F2' : 'ENV'; setWideLabel(); push(); saveSettings(); }
function setDrums(v) { S.drums = v; S.drumsTouched = true; $('#drums').setAttribute('aria-pressed', v); push(); }
function setClean(v) { S.clean = v; document.body.classList.toggle('clean', v); if (v) { $('#panel').hidden = true; $('#set-btn').setAttribute('aria-pressed', 'false'); toast(L('录屏模式：按 H 或点右上角恢复', 'Recording mode: press H or tap the top-right corner to exit')); } }
const tr = d => { S.manTr = Math.max(-5, Math.min(5, S.manTr + d)); push(); { const nm = mName(rootNote() + transpose()); flash(FL((d > 0 ? '升调 ' : '降调 ') + nm, (d > 0 ? 'Up ' : 'Down ') + nm, (d > 0 ? '↑ ' : '↓ ') + nm), 'tr'); } };

async function begin(cam) {
  $('#intro').hidden = true;
  try { await initAudio(); S.audioErr = null; } catch (e) { console.error(e); S.audioErr = e; }
  if (cam) await startCamera(); else { S.input = 'pointer'; toast(L('在画面里按住拖：上下 = 张嘴，左右 = 嘟嘴 ↔ 咧嘴', 'Press and drag in the picture: up/down = open, left/right = pucker ↔ smile')); }
}
function setWideLabel() { $('#ml-wide').textContent = S.vowel ? L('咧嘴 → F2', 'Smile → F2') : L('咧嘴 → ENV', 'Smile → ENV'); }
function applyLang() {
  const en = S.lang === 'en';
  document.documentElement.lang = en ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach(el => { if (el.dataset.zh == null) el.dataset.zh = el.innerHTML; el.innerHTML = en ? ascq(el.dataset.i18n) : el.dataset.zh; });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { if (el.dataset.zhTitle == null) el.dataset.zhTitle = el.title; el.title = en ? el.dataset.i18nTitle : el.dataset.zhTitle; });
  $('#lang-btn').textContent = en ? '中文' : 'EN'; $('#intro-lang').textContent = en ? '中文' : 'EN';
  $('#g-wink-b').textContent = S.mode === 'seq' ? L('换音型', 'Pattern') : L('换波形', 'Wave');
  $('#cam-btn').textContent = S.camOn ? L('关闭摄像头', 'Camera off') : L('打开摄像头', 'Camera on');
  setWideLabel(); midiUI(); for (const k in lastTxt) delete lastTxt[k];
  if (CAL_RUN) showCalStep();
  if (!$('#panel').hidden) renderDiag();
}
function setLang(l) { S.lang = l; applyLang(); saveSettings(); }
$('#cam-s').onchange = e => switchCam(e.target.value);
// ---- MIDI 输出 ----
function midiStatus(t) { setTxt('midi-st', t); }
function midiCC(cc, v) { if (MIDI.out) try { MIDI.out.send([0xB0 + MIDI.ch - 1, cc, v]); MIDI.sent++; MIDI.lastAt = performance.now(); MIDI.lastMsg = 'CH' + MIDI.ch + ' · CC' + cc + ' = ' + v; } catch (e) {} }
async function midiInit() {
  if (!navigator.requestMIDIAccess) { midiStatus(L('这个浏览器不支持 Web MIDI，请用 Chrome 或 Edge。', 'No Web MIDI in this browser. Use Chrome or Edge.')); return false; }
  try { MIDI.access = MIDI.access || await navigator.requestMIDIAccess({ sysex: false }); }
  catch (e) { midiStatus(L('MIDI 权限被拒绝了：点地址栏左边的图标允许 MIDI。', 'MIDI permission denied. Allow it from the icon in the address bar.')); return false; }
  MIDI.access.onstatechange = midiPorts; midiPorts(); return true;
}
function midiPorts() {
  const outs = [...MIDI.access.outputs.values()], sel = $('#midi-port');
  sel.replaceChildren(...outs.map(o => { const op = document.createElement('option'); op.value = o.id; op.textContent = o.name; return op; }));
  // 默认挑虚拟口（loopMIDI / IAC），不挑系统自带的 GS 波表
  const pick = outs.find(o => o.id === MIDI.port) || outs.find(o => /loopmidi|iac|virtual|bus/i.test(o.name)) || outs.find(o => !/wavetable|gs synth/i.test(o.name)) || outs[0];
  MIDI.out = pick || null; if (pick) sel.value = pick.id;
  MIDI.last = {};
  midiStatus(outs.length ? L('发往：', 'Sending to: ') + (pick ? pick.name : '') : L('没找到 MIDI 输出口。Windows 用 loopMIDI 建一个口；Mac 在「音频 MIDI 设置」里打开 IAC 驱动。', 'No MIDI outputs. On Windows create a port in loopMIDI; on Mac enable the IAC Driver in Audio MIDI Setup.'));
}
function midiPaused() { return !$('#panel').hidden; }   // 设置面板开着 = 正在绑定：别让脸上别的动作抢先被 DAW 抓走
function midiTick() {
  if (!MIDI.on || !MIDI.out || MIDI.learn || midiPaused()) return;
  for (const m of MIDI_MAP) { if (m.k === 'acc') continue; const v = Math.round(127 * clamp01(V[m.k] || 0)); if (MIDI.last[m.cc] !== v) { MIDI.last[m.cc] = v; midiCC(m.cc, v); } }
}
function midiAccent() { if (!MIDI.on || MIDI.learn || midiPaused()) return; midiCC(80, 127); setTimeout(() => midiCC(80, 0), 120); }
// 学习：只发这一个 CC，0 → 127 → 0 来回扫两遍（2 秒），这时 DAW 里点 MIDI Learn 就只会抓到它
// 扫完不重发别的 CC：DAW 的 Learn 可能还开着
function midiLearn(m) {
  if (!MIDI.on || !MIDI.out) return;
  if (MIDI.learnIv) clearInterval(MIDI.learnIv);
  MIDI.learn = m; MIDI.learnT = performance.now();
  const name = L(m.zh, m.en) + ' · CC' + m.cc;
  MIDI.learnIv = setInterval(() => {
    const e = (performance.now() - MIDI.learnT) / 1000;
    if (e < 3) { midiStatus(L('3 秒后单独发 ', 'Sending only ') + name + L('，现在去 DAW 里点 Link / Learn …', ' in a moment. Go click Link / Learn in your DAW … ') + Math.ceil(3 - e)); return; }
    const p = (e - 3) / 3;
    if (p >= 1) { clearInterval(MIDI.learnIv); MIDI.learnIv = 0; midiCC(m.cc, 0); MIDI.last[m.cc] = 0; MIDI.learn = null; midiStatus(L('发完了：', 'Done: ') + name + L('。DAW 里抓到的应该是这个 CC。', '. Your DAW should have caught this CC.')); return; }
    midiStatus(L('正在单独发 ', 'Sending only ') + name + ' …');
    midiCC(m.cc, Math.round(127 * (0.5 - 0.5 * Math.cos(p * Math.PI * 4))));
  }, 20);
}
function midiMuteApply() { if (A.out && A.ctx) A.out.gain.setTargetAtTime(MIDI.on && MIDI.mute ? 0 : 0.8, A.ctx.currentTime, 0.03); }
function midiUI() {
  $('#midi-on').checked = MIDI.on; $('#midi-box').hidden = !MIDI.on; $('#midi-mute').checked = MIDI.mute;
  $('#midi-ch').replaceChildren(...Array.from({ length: 16 }, (_, i) => { const o = document.createElement('option'); o.value = i + 1; o.textContent = i + 1; return o; })); $('#midi-ch').value = MIDI.ch;
  $('#midi-map').replaceChildren(...MIDI_MAP.map(m => { const r = document.createElement('div'); r.className = 'mrow';
    const n = document.createElement('span'); n.textContent = L(m.zh, m.en) + ' → CC' + m.cc;
    const b = document.createElement('button'); b.textContent = L('学习', 'Learn'); b.onclick = () => midiLearn(m); r.append(n, b); return r; }));
}
$('#midi-on').onchange = async e => {
  MIDI.on = e.target.checked && await midiInit(); if (!MIDI.on) e.target.checked = false;
  $('#midi-box').hidden = !MIDI.on; MIDI.last = {}; midiMuteApply(); saveSettings();
};
$('#midi-port').onchange = e => { MIDI.port = e.target.value; MIDI.out = MIDI.access && MIDI.access.outputs.get(MIDI.port) || null; MIDI.last = {}; midiStatus(L('发往：', 'Sending to: ') + (MIDI.out ? MIDI.out.name : '')); saveSettings(); };
$('#midi-ch').onchange = e => { MIDI.ch = +e.target.value; MIDI.last = {}; saveSettings(); };
$('#midi-mute').onchange = e => { MIDI.mute = e.target.checked; midiMuteApply(); saveSettings(); };
$('#midi-sec').hidden = !MIDI_UI;
// 顶栏 MIDI 指示：在发 = 绿灯闪；面板开着 / 正在学习 = 暂停（写清楚怎么恢复）
setInterval(() => {
  const chip = $('#midichip'); chip.hidden = !(MIDI_UI && MIDI.on);
  if (chip.hidden) return;
  const paused = midiPaused() && !MIDI.learn, live = performance.now() - (MIDI.lastAt || 0) < 160;
  chip.classList.toggle('live', live && !paused); chip.classList.toggle('pause', paused);
  setTxt('midichip-t', paused ? L('MIDI 暂停', 'MIDI paused') : 'MIDI');
  $('#midi-pause').hidden = !paused;
  setTxt('midi-last', MIDI.lastMsg ? L('最近发出：', 'Last sent: ') + MIDI.lastMsg : '');
}, 120);
midiUI(); if (MIDI.on) midiInit().then(ok => { MIDI.on = ok; midiUI(); });
$('#cam-icon').onclick = $('#cam-tip').onclick = () => { const m = $('#cam-menu'); m.hidden = !m.hidden; if (!m.hidden) fillCamPicker(); syncCamWarn(); };
document.addEventListener('pointerdown', e => { if (!$('#campick').contains(e.target)) $('#cam-menu').hidden = true; });
// 摄像头有没有问题：画面全黑 / 一片单色（虚拟摄像头软件没开、镜头盖着）超过 1.5 秒，或者开了 5 秒一张脸都没见过
const smp = document.createElement('canvas'); smp.width = 16; smp.height = 12; const smpG = smp.getContext('2d', { willReadFrequently: true });
let camDarkSince = -1;
function camLooksDead() {
  if (!stream || video.readyState < 2) return false;
  try {
    smpG.drawImage(video, 0, 0, 16, 12); const d = smpG.getImageData(0, 0, 16, 12).data; let m = 0, m2 = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { const y = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; m += y; m2 += y * y; }
    m /= n; const sd = Math.sqrt(Math.max(0, m2 / n - m * m)); S.camLum = m; return m < 14 || sd < 5;
  } catch (e) { return false; }
}
function syncCamWarn() {
  const bad = !!S.camBad, menu = !$('#cam-menu').hidden;
  $('#cam-bang').hidden = !bad; $('#cam-tip').hidden = !bad || menu;
  $('#cam-tip').textContent = L('画面不对？换一个摄像头', 'No picture? Switch camera');
}
setInterval(() => {
  const live = (S.camOn || S.camLoading) && S.input !== 'video' && !!stream, t = performance.now() / 1000;
  if (!live) { S.camBad = false; camDarkSince = -1; syncCamWarn(); return; }
  if (camLooksDead()) { if (camDarkSince < 0) camDarkSince = t; } else camDarkSince = -1;
  const dark = camDarkSince >= 0 && t - camDarkSince > 1.5, noFace = S.camOn && D.faces === S.facesAt && t - (S.camAt || t) > 5;
  S.camBad = dark || noFace; syncCamWarn();
}, 400);
/* ---------------- 环境检查：打开网页就看，有问题直接写在开始页上（附带怎么办） ---------------- */
const UA = navigator.userAgent;
const INAPP = /Instagram|FBAN|FBAV|FB_IAB|MicroMessenger|WeChat|Line\/|TikTok|musical_ly|Bytedance|Weibo|QQ\/|XiaoHongShu|xhsdiscover|Snapchat|Twitter|LinkedInApp/i.test(UA);
const IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function envIssues() {
  const out = [], AC = window.AudioContext || window.webkitAudioContext, miss = [];
  // App 内置浏览器：很多（比如安卓 Instagram）其实能用，所以只轻轻提一句；真打不开时出错卡片里再说
  if (INAPP) out.push(['tip', L('如果这里打不开摄像头：点右上角 ⋯ → 在浏览器中打开。', 'Camera not working here? Tap ⋯ → Open in browser.'), 'copy']);
  else if (!window.isSecureContext) out.push(['bad', L('摄像头只能在 https 网址下用。', 'The camera only works on https.')]);
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) miss.push(L('摄像头接口', 'camera access'));
  if (NO_WASM) miss.push('WebAssembly');
  if (!AC || !('audioWorklet' in AC.prototype)) miss.push('AudioWorklet');
  if (miss.length && !INAPP) out.push(['bad', L('这个浏览器缺少：', 'This browser is missing: ') + miss.join(L('、', ', ')) + L('。', '. ') + (IS_EDGE && NO_WASM ? edgeTip() : L('请用最新版 Chrome、Edge 或 Safari。', 'Please use the latest Chrome, Edge or Safari.'))]);
  if (IOS) out.push(['tip', L('iPhone 没声音？把机身侧面的静音开关拨开。', 'No sound on iPhone? Turn off silent mode (the side switch).')]);
  return out;
}
function showEnv() {
  const box = $('#envwarn'), items = envIssues();
  box.hidden = !items.length;
  box.replaceChildren(...items.map(([kind, text, act]) => {
    const p = document.createElement('p'); p.className = kind; const t = document.createElement('span'); t.textContent = text; p.append(t);
    if (act === 'copy') { const b = document.createElement('button'); b.textContent = L('复制链接', 'Copy link');
      b.onclick = async () => { try { await navigator.clipboard.writeText(location.href); b.textContent = L('已复制', 'Copied'); } catch (e) { prompt(L('复制这个链接，到浏览器里打开：', 'Copy this link and open it in your browser:'), location.href); } }; p.append(b); }
    return p;
  }));
}
showEnv();
// 用的时候：画面右上角一条提示（按轻重只显示一条）——声音没起来 / 光线太暗 / 设备太慢
let slowSince = -1;
setInterval(() => {
  const t = performance.now() / 1000, el = $('#mwarn'), cam = S.camOn && S.input === 'camera';
  if (cam && S.infAvg > 80) { if (slowSince < 0) slowSince = t; } else slowSince = -1;
  let msg = '', act = null;
  if (S.audioErr) { msg = L('声音没起来，点这里再试一次。还不行就换 Chrome。', 'Sound didn’t start. Tap here to retry; if it still fails, try Chrome.'); act = 'audio'; }
  else if (A.ctx && A.ctx.state === 'suspended' && S.input !== 'none') { msg = L('浏览器把声音停了，点这里打开。', 'The browser paused the sound. Tap here to turn it on.'); act = 'audio'; }
  else if (cam && !S.face && !S.camBad && S.camLum != null && S.camLum < 45 && t - (S.camAt || t) > 3) msg = L('画面有点暗，识别不到脸。开个灯，或者面向光源。', 'It’s a bit dark to find your face. Turn on a light or face a window.');
  else if (slowSince >= 0 && t - slowSince > 4) msg = L('这台设备识别得有点慢（每帧 ', 'Face tracking is slow on this device (') + Math.round(S.infAvg) + L(' ms），动作会跟不上。关掉其他标签页，或者换台电脑用 Chrome。', ' ms per frame). Close other tabs, or try Chrome on a computer.');
  el.hidden = !msg; if (msg && el.textContent !== msg) el.textContent = msg; el.dataset.act = act || '';
}, 500);
$('#mwarn').onclick = async () => { if ($('#mwarn').dataset.act !== 'audio') return; try { A.p = A.p && !S.audioErr ? A.p : null; await initAudio(); S.audioErr = null; } catch (e) { S.audioErr = e; } };
$('#camerr-retry').onclick = async () => { $('#camerr').hidden = true; try { await initAudio(); } catch (e) {} startCamera(); };
for (const el of [$('#campick'), $('#camerr')]) el.addEventListener('pointerdown', e => e.stopPropagation());   // 别让画面上的拖动接管了下拉框和按钮
$('#camerr-ptr').onclick = () => { $('#camerr').hidden = true; S.input = 'pointer'; };
function showIntroLoad() {
  if ((NO_WASM || recFail) && !recDone) { $('#intro-load').classList.add('bad'); setTxt('intro-load-t', L('这个浏览器现在跑不了人脸识别。', 'Face tracking can’t run in this browser right now. ') + edgeTip()); return; }
  $('#intro-load').classList.remove('bad');
  setTxt('intro-load-t', loadText()); $('#intro-load-b').style.width = (recDone ? 100 : Math.round(preFrac() * 100)) + '%';
  $('#intro-load').classList.toggle('ok', recDone);
}
const introLoadT = setInterval(() => { showIntroLoad(); if (recDone) clearInterval(introLoadT); }, 150);
if (!Q.has('video')) initRecognizer().catch(() => {});
$('#lang-btn').onclick = $('#intro-lang').onclick = () => setLang(S.lang === 'en' ? 'zh' : 'en');
if (Q.has('dev')) { $('#adv').hidden = false; $('#lat').hidden = false; }   // 手势开关、手感、延迟统计、录屏、自检、键盘：给自己调试用
$('#go-cam').onclick = () => begin(true);
$('#go-ptr').onclick = () => begin(false);
$('#m-free').onclick = () => setMode('free');
$('#m-seq').onclick = () => { initAudio(); setMode('seq'); };
$('#vowel').onclick = () => setVowel(!S.vowel);
$('#drums').onclick = () => { initAudio(); setDrums(!S.drums); };
$('#cam-btn').onclick = async () => { $('#intro').hidden = true; $('#panel').hidden = true; $('#set-btn').setAttribute('aria-pressed', 'false'); await initAudio(); if (S.camOn) stopCamera(); else startCamera(); };
$('#cal-btn').onclick = () => { $('#panel').hidden = true; $('#set-btn').setAttribute('aria-pressed', 'false'); startCalib(); };
$('#set-btn').onclick = () => { const p = $('#panel'); p.hidden = !p.hidden; $('#set-btn').setAttribute('aria-pressed', !p.hidden); if (!p.hidden) renderDiag(); };
$('#tr-dn').onclick = () => tr(-1); $('#tr-up').onclick = () => tr(1);
$('#w-saw').onclick = () => setWave(0); $('#w-sq').onclick = () => setWave(1);
document.querySelectorAll('#pats button').forEach(b => { b.onclick = () => setPattern(+b.dataset.p); });
const dropBtn = $('#drop-btn');
const dropOn = v => { S.dropHold = v; dropBtn.classList.toggle('down', v); push(); if (v) { initAudio(); hit('g-brow'); flash('REV · DLY', 'f2'); } };
dropBtn.addEventListener('pointerdown', e => { e.preventDefault(); try { dropBtn.setPointerCapture(e.pointerId); } catch (err) {} dropOn(true); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(n => dropBtn.addEventListener(n, () => { if (S.dropHold) dropOn(false); }));
$('#unclean').onclick = () => setClean(false);
$('#clean-btn').onclick = () => setClean(true);
$('#cal-clear').onclick = () => { store.del('lip303-cal'); CAL = { ...CAL_DEFAULT }; toast(L('已清除校准，用默认值', 'Calibration cleared, using defaults')); };
document.querySelectorAll('[data-g]').forEach(el => { el.checked = S.gest[el.dataset.g]; el.onchange = () => { S.gest[el.dataset.g] = el.checked; saveSettings(); push(); syncGest(); }; });
function syncGest() { $('#g-wink').classList.toggle('off', !S.gest.wink); $('#g-brow').classList.toggle('off', !S.gest.brow); $('#g-acc').classList.toggle('off', !S.gest.jaw && !S.gest.nod); }
$('#smooth').value = S.smooth; $('#smooth').oninput = e => { S.smooth = +e.target.value; F = mkF(); saveSettings(); };
$('#oct').value = String(S.oct); $('#oct').onchange = e => { S.oct = +e.target.value; push(); saveSettings(); };
$('#verify').onclick = () => verify();
$('#diag-reset').onclick = () => { for (const k of ['inf', 'frameToCtl', 'capToCtl', 'capToDispatch', 'frameWait', 'interval', 'vsync']) D[k].clear(); renderDiag(); };
$('#diag-export').onclick = () => {
  const blob = new Blob([JSON.stringify(snapshot(true), null, 1)], { type: 'application/json' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'lipsync303-diag-' + Date.now() + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.repeat || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === '1') setMode('free'); else if (k === '2') { initAudio(); setMode('seq'); }
  else if (k === 'arrowleft') tr(-1); else if (k === 'arrowright') tr(1);
  else if (k === ' ') { e.preventDefault(); nextPattern(1); }
  else if (k === 'a') accent('key');
  else if (k === 'd' || k === 'shift') { if (!S.dropHold) dropOn(true); }
  else if (k === 'v') setVowel(!S.vowel); else if (k === 'b') setDrums(!S.drums);
  else if (k === 'c') startCalib(); else if (k === 'h') setClean(!S.clean); else if (k === 'l') setLang(S.lang === 'en' ? 'zh' : 'en');
});
addEventListener('keyup', e => { const k = e.key.toLowerCase(); if ((k === 'd' || k === 'shift') && S.dropHold) dropOn(false); });

/* ---------------- 诊断面板 ---------------- */
const f1 = v => Number.isFinite(v) ? v.toFixed(1) : '—';
function snapshot(full) {
  const o = {
    at: new Date().toISOString(), ua: navigator.userAgent, input: S.input, backend: D.backend, auto: AUTO.log, infGPU: D.infBy.GPU.snap(), infCPU: D.infBy.CPU.snap(), src: D.src, warmMs: +D.warm.toFixed(1),
    video: { w: video.videoWidth, h: video.videoHeight, settings: stream && stream.getVideoTracks()[0] ? stream.getVideoTracks()[0].getSettings() : null, test: S.testVideo || null },
    fps: +rate().toFixed(1), frames: D.frames, faces: D.faces,
    inferenceMs: D.inf.snap(), frameToControlMs: D.frameToCtl.snap(), captureToControlMs: D.capToCtl.snap(), captureToDispatchMs: D.capToDispatch.snap(),
    frameWaitMs: D.frameWait.snap(), frameIntervalMs: D.interval.snap(), vsyncDeviationMs: D.vsync.snap(),
    audio: A.ctx ? { sampleRate: A.ctx.sampleRate, baseLatencyMs: +(1000 * (A.ctx.baseLatency || 0)).toFixed(1), outputLatencyMs: +(1000 * (A.ctx.outputLatency || 0)).toFixed(1) } : null,
    filter: { smooth: S.smooth, lead: FP.lead }, settings: { mode: S.mode, vowel: S.vowel, gest: S.gest }, cal: CAL,
  };
  if (full) o.trace = TRACE.slice();
  return o;
}
function renderDiag() {
  const s = snapshot(false), a = s.audio, ctl = D.capToCtl.v.length ? D.capToCtl.pct(50) : D.frameToCtl.pct(50);
  const est = ctl + (a ? a.baseLatencyMs + a.outputLatencyMs : NaN) + 3;
  const rows = [
    [L('后端', 'Backend'), s.backend ? s.backend + '（' + s.src + '）' : '—'], [L('自动选择', 'Auto pick'), AUTO.log || (AUTO.on ? '测量中…' : '—')], [L('输入', 'Input'), s.input + (s.video.w ? ' · ' + s.video.w + '×' + s.video.h : '')],
    [L('识别帧率', 'Tracking rate'), f1(s.fps) + ' fps'], [L('摄像头帧间隔', 'Camera frame interval'), f1(s.frameIntervalMs.median) + ' ms'],
    [L('推理 中位 / P95', 'Inference median / P95'), f1(s.inferenceMs.median) + ' / ' + f1(s.inferenceMs.p95) + ' ms'],
    [L('发帧→控制', 'Frame → control'), f1(s.frameToControlMs.median) + ' / ' + f1(s.frameToControlMs.p95) + ' ms'],
    [L('采集→控制', 'Capture → control'), s.captureToControlMs.n ? f1(s.captureToControlMs.median) + ' / ' + f1(s.captureToControlMs.p95) + ' ms' : L('—（视频文件没有采集时间）', '— (no capture time for video files)')],
    [L('刷新对齐偏差', 'Vsync deviation'), f1(s.vsyncDeviationMs.median) + ' ms'],
    [L('声卡 base / output', 'Audio base / output'), a ? f1(a.baseLatencyMs) + ' / ' + f1(a.outputLatencyMs) + ' ms' : '—'],
    [L('软件段估算', 'Software total (est.)'), Number.isFinite(est) ? f1(est) + ' ms' : '—'],
  ];
  $('#diag').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

/* ---------------- 版面 ---------------- */
let DPR = 1, MW = 0, MH = 0, SW = 0, SH = 0, mRect = null, sRect = null;
function fit(c, w, h) { const W = Math.round(w * DPR), H = Math.round(h * DPR); if (c.width !== W || c.height !== H) { c.width = W; c.height = H; } }
function layout() {
  DPR = Math.min(2, devicePixelRatio || 1);
  MW = mirror.clientWidth; MH = mirror.clientHeight; SW = sp.clientWidth; SH = sp.clientHeight;
  fit(ov, MW, MH); fit(sp, SW, SH);
  const bv = $('#bv'); if (bv.width !== MW || bv.height !== MH) { bv.width = MW; bv.height = MH; }
  mRect = mirror.getBoundingClientRect(); sRect = sp.getBoundingClientRect();
}
new ResizeObserver(layout).observe(mirror); new ResizeObserver(layout).observe(sp); addEventListener('resize', layout);
// 视频（object-fit: cover + 镜像）里的归一坐标 → 镜子里的坐标
function vmap(i) {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480, s = Math.max(MW / vw, MH / vh), dx = (MW - vw * s) / 2, dy = (MH - vh * s) / 2;
  return [MW - (dx + LM[2 * i] * vw * s), dy + LM[2 * i + 1] * vh * s];
}

/* ---------------- 画面（一线一色：一种墨线，颜色只说声音） ---------------- */
const C = { ink: '#1f2328', ink2: '#5b564c', ink3: '#8a8478', paper: '#F6F3EC', card: '#FFFDF7', slate: '#E4DFD4', acid: '#F2B42C', pale: '#FBE3A0', red: '#D9483B', pink: '#E9627E' };
const NUM = 'Inter,"Segoe UI",system-ui,sans-serif';
const LIP_OUT = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
const LIP_IN = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
const FMIN = 40, FMAX = 6000, DBT = 18, DBB = -60;
const hist = []; let lastStep = -1;
// 4 极梯形低通的幅频：|H| = (1 + k/2) / |(1 + jω/ωc)^4 + k|
function ladderMag(f, fc, k) { const w = f / fc, re2 = 1 - w * w, im2 = 2 * w, re = re2 * re2 - im2 * im2 + k, im = 2 * re2 * im2; return (1 + 0.5 * k) / Math.hypot(re, im); }
function bpMag(f, f0, kq) { const w = f / f0; return kq * w / Math.hypot(1 - w * w, kq * w); }
function respAt(f, tel) { let m = ladderMag(f, tel.fc, 3.7 * tel.res); if (tel.a2 > 0.01) m += bpMag(f, tel.f2, 0.11) * tel.a2 * 3.2; return m; }
const db = v => 20 * Math.log10(Math.max(1e-6, v));
const brightness = fc => clamp01(Math.log(fc / 150) / Math.log(2500 / 150));
function vowelGuess(tel) {
  const F1 = tel.cut;
  if (tel.a2 > 0.35 && tel.f2 > 1700) return F1 < 520 ? 'i' : 'e';
  if (V.round > 0.55 && F1 < 1100) return F1 < 500 ? 'u' : 'o';
  return F1 < 380 ? 'u' : F1 < 750 ? 'o' : 'a';
}

let lastDraw = 0;
function frame(now) { requestAnimationFrame(frame); if (now - lastDraw < 15) return; lastDraw = now; step(); }   // 最多 60 帧：高刷屏上少占 GPU，给识别让路
let uiT = 0; const lastTxt = {};
function setTxt(id, v) { if (lastTxt[id] !== v) { lastTxt[id] = v; const el = $('#' + id); if (el) el.textContent = v; } }
function step() {
  const now = performance.now(), t = now / 1000;
  // 鼠标 / 触屏，或摄像头暂时看不到脸：每帧喂一次
  if (S.input === 'pointer') tick(t);
  else if (isCam()) {
    if (S.face && t - S.lastFaceAt > 0.5) { S.face = false; LM = null; if (beautyOn()) BV.setMask(null); }
    if (!S.face) {
      // 跟丢脸：保持 0.3 秒，再慢慢回到“闭嘴”；1.5 秒后鼠标 / 手指可以接手
      if (!(ptrActive() && S.ptr.down) && t - S.lastFaceAt > 0.3) { const k = 1 - Math.exp(-0.016 / 0.18); for (const n in N) N[n] += (0 - N[n]) * k; }
      calIdle(); tick(t);
    }
  }
  const tel = A.tel;
  hist.push({ t, fc: tel.fc, a: tel.a, step: tel.step !== lastStep ? tel.step : -1 }); lastStep = tel.step;
  while (hist.length && t - hist[0].t > 4.2) hist.shift();
  if (!mRect) layout();
  drawBeauty();
  const mouth = drawMirror(tel), peak = drawSound(tel);
  drawLink(mouth, peak, tel);
  updateDom(tel, now);
}

function updateDom(tel, now) {
  setTxt('p-cut', fmtHz(tel.cut)); setTxt('p-res', tel.res.toFixed(2)); setTxt('p-env', S.vowel ? fmtHz(tel.f2) : tel.env.toFixed(2)); setTxt('p-dly', Math.round(tel.send * 100) + '%');
  setTxt('note', mName(rootNote() + transpose()));
  const pc = v => Math.round(v * 100) + '%';
  $('#mb-open').style.width = pc(V.open); $('#mb-round').style.width = pc(V.round); $('#mb-wide').style.width = pc(V.wide);
  setTxt('mv-open', pc(V.open)); setTxt('mv-round', pc(V.round)); setTxt('mv-wide', pc(V.wide));
  // 动作提示里的底色条 = 此刻识别到的强度（挑眉多少、眼睛闭了多少）
  const camLive = isCam() && S.face;
  $('#g-brow').style.setProperty('--lv', Math.round(100 * (camLive && S.gest.brow ? V.brow : 0)) + '%');
  $('#g-wink').style.setProperty('--lv', Math.round(100 * (camLive && S.gest.wink ? V.eye : 0)) + '%');
  // 占位提示
  const showPh = (!S.camOn || !S.face) && !(S.camOn && CAL_RUN && S.face);
  $('#ph').hidden = !showPh;
  $('#ph-bar').hidden = !S.camLoading;
  if (S.camLoading) { $('#ph-bar-b').style.width = Math.round(preFrac() * 100) + '%'; setTxt('ph-b', loadText()); setTxt('ph-s', ''); }
  else if (showPh) {
    if (isCam() && !S.face) { setTxt('ph-b', S.input === 'video' ? L('测试视频里暂时没有脸', 'No face in the test video right now') : (D.backend ? L('看不到脸', 'No face found') : L('加载识别模型…', 'Loading face model…')));
      setTxt('ph-s', S.camBad ? L('画面不对？点左上角的摄像头图标换一个 ↖', 'Wrong picture? Tap the camera icon at the top-left ↖') : ''); }
    else { setTxt('ph-b', L('按住拖动', 'Press and drag')); setTxt('ph-s', L('上下张嘴，左右嘟嘴 ↔ 咧嘴', 'Up/down: open · left/right: pucker ↔ smile')); }
  }
  if (now - uiT > 250) {
    uiT = now;
    if (isCam()) {
      const ms = D.capToCtl.v.length ? D.capToCtl.pct(50) : D.frameToCtl.pct(50);
      const camFps = D.interval.v.length ? 1000 / D.interval.pct(50) : NaN;
      setTxt('lat', Number.isFinite(ms) ? L('延迟 ', 'Latency ') + Math.round(ms) + ' ms' : '');
      const base = S.face ? (S.input === 'video' ? L('测试视频', 'Test video') : L('看到你了', 'Face found')) : (D.backend ? L('找脸…', 'Looking for a face…') : L('加载识别模型…', 'Loading face model…'));
      setStatus(S.face ? 'ok' : 'wait', base + (Number.isFinite(ms) ? L(' · 摄像头 ', ' · camera ') + Math.round(camFps) + L(' · 识别 ', ' · tracking ') + Math.round(rate()) + L(' 帧/秒 · 延迟 ', ' fps · latency ') + Math.round(ms) + ' ms' : ''));
    } else { setTxt('lat', ''); if (S.input === 'pointer') setStatus('', L('鼠标 / 手指', 'Mouse / touch')); }
    if (!$('#panel').hidden) renderDiag();
  }
}

function drawMirror(tel) {
  const g = og; g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, MW, MH);
  const br = brightness(tel.fc), on = clamp01(tel.a * 1.4);
  if (S.camOn && LM) {
    const path = idx => { g.beginPath(); idx.forEach((j, n) => { const [x, y] = vmap(j); n ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); };
    g.lineJoin = 'round';
    // 嘴里填 acid 黄：声音越亮越满
    path(LIP_IN); g.globalAlpha = 0.15 + 0.8 * br * on; g.fillStyle = C.acid; g.fill(); g.globalAlpha = 1;
    // 一种墨线（下面垫一层纸色，深色画面里也看得清）
    for (const idx of [LIP_OUT, LIP_IN]) { path(idx); g.strokeStyle = C.card; g.lineWidth = idx === LIP_OUT ? 5.5 : 4; g.stroke(); g.strokeStyle = C.ink; g.lineWidth = idx === LIP_OUT ? 2.6 : 1.6; g.stroke(); }
    const up = vmap(13), dn = vmap(14), l = vmap(61), r = vmap(291);
    if (CAL_RUN) drawGuide(g);
    return [(l[0] + r[0]) / 2, (up[1] + dn[1]) / 2];
  }
  if (S.camOn && CAL_RUN) drawGuide(g);
  if (S.camOn || S.camLoading) return null;
  // 没有摄像头：画一张示意嘴，跟着鼠标 / 手指开合
  const cx = MW / 2, cy = MH * 0.42, sc = Math.min(MW, MH) * 0.24;
  const o = V.open, rd = V.round, wd = V.wide;
  const hw = sc * (1 + 0.32 * wd - 0.42 * rd), oh = sc * (0.04 + 0.62 * o) * (1 + 0.25 * rd), lip = sc * 0.16 * (1 + 0.5 * rd), iw = hw * (0.86 - 0.3 * rd);
  g.lineJoin = 'round';
  g.beginPath(); g.moveTo(cx - hw, cy);
  g.bezierCurveTo(cx - hw * 0.6, cy - oh / 2 - lip * 1.1, cx - hw * 0.2, cy - oh / 2 - lip * 1.4, cx, cy - oh / 2 - lip * 0.9);
  g.bezierCurveTo(cx + hw * 0.2, cy - oh / 2 - lip * 1.4, cx + hw * 0.6, cy - oh / 2 - lip * 1.1, cx + hw, cy);
  g.bezierCurveTo(cx + hw * 0.6, cy + oh / 2 + lip * 1.5, cx - hw * 0.6, cy + oh / 2 + lip * 1.5, cx - hw, cy);
  g.closePath(); g.fillStyle = C.card; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2.6; g.stroke();
  g.beginPath(); g.ellipse(cx, cy, iw, Math.max(1.5, oh / 2), 0, 0, Math.PI * 2);
  g.globalAlpha = 0.25 + 0.75 * Math.max(br * on, 0.15); g.fillStyle = C.acid; g.fill(); g.globalAlpha = 1; g.lineWidth = 2; g.stroke();
  if (S.ptr.down) { g.beginPath(); g.arc(S.ptr.x * MW, S.ptr.y * MH, 10, 0, Math.PI * 2); g.strokeStyle = C.ink; g.lineWidth = 2; g.stroke(); }
  return [cx, cy];
}
function drawGuide(g) {   // 校准时的取景框
  g.save(); g.setLineDash([8, 8]); g.strokeStyle = C.ink; g.lineWidth = 2.5;
  g.beginPath(); g.ellipse(MW / 2, MH * 0.47, Math.min(MW * 0.26, MH * 0.3), Math.min(MH * 0.38, MW * 0.36), 0, 0, Math.PI * 2); g.stroke(); g.restore();
}

function drawSound(tel) {
  const g = sg; g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, SW, SH);
  if (SW < 40 || SH < 60) return null;
  let y0 = 0;
  // ---- 16 步（跟律动） ----
  if (S.mode === 'seq') {
    const AS = (PRESETS[tel.pat] || PRESETS[0]).steps, off = tel.step >= 0 ? Math.floor(tel.step / 16) * 16 : 0, P = AS.slice(off, off + 16).map(q => [q.n, q.acc, q.sl, q.rest]), sh = Math.min(40, SH * 0.16), cw = SW / 16;
    g.fillStyle = C.card; g.strokeStyle = C.ink; g.lineWidth = 2; rr(g, 1, 1, SW - 2, sh - 2, 10); g.fill(); g.stroke();
    for (let j = 0; j < 16; j++) {
      const q = P[j] || [0, 0, 0, 1], x = j * cw, cur = j + off === tel.step;
      if (j % 4 === 0 && j) { g.strokeStyle = 'rgba(31,35,40,.15)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, sh - 6); g.stroke(); }
      if (q[3]) { g.beginPath(); g.arc(x + cw / 2, sh - 11, 3, 0, Math.PI * 2); g.fillStyle = C.card; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.6; g.stroke(); continue; }
      const yy = sh - 11 - (sh - 20) * (q[0] / 24), w = cw * 0.56, hh = cur ? 8 : 5;
      g.fillStyle = cur ? C.acid : q[1] ? C.red : C.ink; g.fillRect(x + (cw - w) / 2, yy - hh / 2, w, hh);
      if (cur) { g.strokeStyle = C.ink; g.lineWidth = 1.6; g.strokeRect(x + (cw - w) / 2, yy - hh / 2, w, hh); }
      if (q[2] && P[(j + 1) % 16] && !P[(j + 1) % 16][3]) { const nq = P[(j + 1) % 16], ny = sh - 11 - (sh - 20) * (nq[0] / 24); g.strokeStyle = C.ink; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x + (cw + w) / 2, yy); g.lineTo(x + cw + (cw - w) / 2, ny); g.stroke(); }
    }
    y0 = sh + 10;
  }
  // ---- 频谱 ----
  const th = Math.min(56, SH * 0.2), plot = { x: 2, y: y0 + 16, w: SW - 4, h: Math.max(50, SH - y0 - 16 - 22 - th - 8) };
  const xf = f => plot.x + plot.w * Math.log(f / FMIN) / Math.log(FMAX / FMIN);
  const yd = d => plot.y + plot.h * (DBT - Math.max(DBB, Math.min(DBT, d))) / (DBT - DBB);
  g.strokeStyle = 'rgba(31,35,40,.08)'; g.lineWidth = 1; g.font = '11px ' + NUM; g.fillStyle = C.ink2; g.textAlign = 'center'; g.textBaseline = 'top';
  for (const [f, lab] of [[100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k']]) { const x = xf(f); g.beginPath(); g.moveTo(x, plot.y); g.lineTo(x, plot.y + plot.h); g.stroke(); g.fillText(lab, x, plot.y + plot.h + 5); }
  // 滤波曲线下面填一块纯色（淡 acid 黄）
  const NPT = 140, pts = [];
  for (let i = 0; i <= NPT; i++) { const f = FMIN * Math.pow(FMAX / FMIN, i / NPT); pts.push([xf(f), yd(db(respAt(f, tel))), f]); }
  g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.lineTo(plot.x + plot.w, plot.y + plot.h); g.lineTo(plot.x, plot.y + plot.h); g.closePath();
  g.fillStyle = C.pale; g.fill();
  // 谐波：锯齿波 1/n × 滤波幅频；被峰顶起来的几根加粗
  const f0 = mtof(tel.m), on = clamp01(tel.a * 1.3), pass = db(respAt(FMIN, tel)), lv = [];
  for (let n = 1; n * f0 < FMAX && n <= 90; n++) { const f = n * f0; if (f >= FMIN) lv.push([f, db((1 / n) * respAt(f, tel))]); }
  const mx = lv.reduce((a, b) => Math.max(a, b[1]), -99);
  for (const [f, d] of lv) {
    const x = xf(f), hot = Math.max(clamp01(1 - (mx - d) / 12), clamp01((db(respAt(f, tel)) - pass - 2) / 6)) > 0.5;
    g.strokeStyle = C.ink; g.globalAlpha = hot ? 0.35 + 0.65 * Math.max(on, 0.2) : 0.3; g.lineWidth = hot ? 3.2 : 1.4;
    g.beginPath(); g.moveTo(x, plot.y + plot.h); g.lineTo(x, yd(d)); g.stroke();
  }
  g.globalAlpha = 1;
  if (f0 >= FMIN) { g.fillStyle = C.ink; g.font = '11px ' + NUM; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(mName(tel.m), xf(f0) + 5, plot.y + plot.h - 3); }
  g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.strokeStyle = C.ink; g.lineWidth = 2.6; g.lineJoin = 'round'; g.stroke();
  g.beginPath(); g.moveTo(plot.x, plot.y + plot.h); g.lineTo(plot.x + plot.w, plot.y + plot.h); g.lineWidth = 2; g.stroke();
  // 峰顶
  let pk = null; for (const p of pts) if (Math.abs(Math.log(p[2] / tel.fc)) < 0.5 && (!pk || p[1] < pk[1])) pk = p;
  if (!pk) pk = [xf(Math.min(FMAX, tel.fc)), yd(db(respAt(tel.fc, tel)))];
  g.beginPath(); g.arc(pk[0], pk[1], 6.5, 0, Math.PI * 2); g.fillStyle = C.acid; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2.2; g.stroke();
  const labs = [{ x: pk[0], y: pk[1], t: fmtHz(tel.fc) }];
  if (tel.a2 > 0.05) {
    const x2 = xf(tel.f2), y2 = yd(db(respAt(tel.f2, tel)));
    g.beginPath(); g.arc(x2, y2, 5.5, 0, Math.PI * 2); g.fillStyle = C.pink; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2; g.stroke();
    labs.push({ x: x2, y: y2, t: 'F2 ' + fmtHz(tel.f2) });
  }
  // 标签：默认放在点的右上；靠右边缘就放左边；和前一个标签重叠就往上挪一行
  g.fillStyle = C.ink; g.font = '700 13px ' + NUM; g.textBaseline = 'bottom';
  const boxes = [];
  labs.sort((a, b) => a.x - b.x);
  for (let k = 0; k < labs.length; k++) {
    const L = labs[k], w = g.measureText(L.t).width, next = labs[k + 1];
    // 右边紧挨着另一个峰：这个标签放到点的左边；靠右边缘也放左边
    const right = L.x + 11 + w > plot.x + plot.w || (next && next.x - L.x < w + 30);
    let x0 = right ? L.x - 11 - w : L.x + 11, y = Math.max(plot.y + 14, L.y - 5);
    for (let k = 0; k < 3 && boxes.some(b => x0 < b.x1 + 6 && x0 + w > b.x0 - 6 && y > b.y - 16 && y - 16 < b.y); k++) y -= 17;
    boxes.push({ x0, x1: x0 + w, y }); g.textAlign = 'left'; g.fillText(L.t, x0, y);
  }
  // ---- CUTOFF 走过的路（4 秒） ----
  const rb = { x: 1, y: SH - th, w: SW - 2, h: th - 1 }, tn = performance.now() / 1000;
  g.fillStyle = C.paper; rr(g, rb.x, rb.y, rb.w, rb.h, 10); g.fill();
  const yr = f => rb.y + rb.h - 6 - (rb.h - 12) * clamp01(Math.log(f / 100) / Math.log(6000 / 100)), xr = tt => rb.x + 8 + (rb.w - 16) * (1 - (tn - tt) / 4);
  if (S.mode === 'seq') { g.strokeStyle = 'rgba(31,35,40,.18)'; g.lineWidth = 1;
    for (const h of hist) if (h.step >= 0) { const x = xr(h.t); if (x < rb.x + 8) continue; g.beginPath(); g.moveTo(x, rb.y + (h.step % 4 ? rb.h * 0.65 : 6)); g.lineTo(x, rb.y + rb.h - 4); g.stroke(); } }
  g.beginPath(); let started = false;
  for (const h of hist) { const x = xr(h.t); if (x < rb.x + 8) continue; const y = yr(h.fc); if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; } }
  g.strokeStyle = C.ink; g.lineWidth = 2.4; g.lineJoin = 'round'; g.stroke();
  if (SW > 480) {   // 字压在线上面，底下垫一块底色
    const txt = L('CUTOFF 走过的路 · 4 秒', 'CUTOFF · last 4 s'); g.font = '11px system-ui,sans-serif'; const tw = g.measureText(txt).width;
    g.fillStyle = C.paper; g.fillRect(rb.x + 6, rb.y + 4, tw + 8, 15); g.fillStyle = C.ink2; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(txt, rb.x + 10, rb.y + 6);
  }
  if (hist.length) { const h = hist[hist.length - 1]; g.beginPath(); g.arc(xr(h.t), yr(h.fc), 5, 0, Math.PI * 2); g.fillStyle = h.a > 0.05 ? C.acid : C.card; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2; g.stroke(); }
  
  return pk;
}
function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
// 嘴 → 峰：同一个共振峰（跨两块画布，画在最上面一层）
function drawLink(mouth, peak, tel) {   // 用 SVG 画：每帧只改一条路径，不用清一张全屏画布
  if (!mouth || !peak || tel.a < 0.02 || S.clean || !$('#calib').hidden) { if (linkP.style.display !== 'none') linkP.style.display = 'none'; return; }
  const ax = mRect.left + mouth[0], ay = mRect.top + mouth[1], bx = sRect.left + peak[0], by = sRect.top + peak[1] - 8;
  const portrait = Math.abs(sRect.top - mRect.top) > Math.abs(sRect.left - mRect.left);
  const cx = portrait ? ax : (ax + bx) / 2, cy = portrait ? (ay + by) / 2 : ay;
  linkP.style.display = ''; linkP.setAttribute('d', `M${ax.toFixed(1)} ${ay.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`);
  linkP.style.opacity = (0.25 + 0.6 * clamp01(tel.a)).toFixed(2);
}

/* ---------------- 离线检查：同一个 worklet，在 OfflineAudioContext 里按脚本跑 ---------------- */
async function verify() {
  const out = $('#vout'); out.textContent = '渲染中…';
  const sr = 48000, dur = 8, oc = new OfflineAudioContext(2, sr * dur, sr);
  await oc.audioWorklet.addModule('worklet.js?v=6');
  const base = { mode: 'free', cut: 300, res: 0.55, env: 0.5, gate: 0, lvl: 1, f2: 1500, f2amt: 0, verbAdd: 0, verbHold: 0, tr: 0, root: 45, wave: 0, drums: 0, vol: 1 };
  const script = [
    [0, base], [0.2, { gate: 1 }], [0.6, { cut: 2500 }], [0.9, { cut: 150, res: 0.95 }], [1.2, { gate: 0 }], [1.26, { gate: 1 }],
    [1.5, 'acc'], [1.8, { f2amt: 1, f2: 2300, cut: 300, res: 0.6 }], [2.4, { tr: 7 }], [2.8, { gate: 0 }],
    [3.0, { mode: 'seq', drums: 1, root: 33, cut: 400, f2amt: 0, tr: 0 }], [4.0, { cut: 2500, res: 0.95 }], [4.5, 'acc'], [5.0, ['pat', 2]], [5.5, { verbHold: 1 }], [6.5, { cut: 150, wave: 1 }],
  ];
  const node = new AudioWorkletNode(oc, 'lip303', procOpts({ init: base, script }));
  buildChain(oc, node, oc.destination);
  const buf = await oc.startRendering(), L0 = buf.getChannelData(0), R0 = buf.getChannelData(1);
  let nan = 0, peak = 0; for (let i = 0; i < L0.length; i++) { const a = L0[i], b = R0[i]; if (!isFinite(a) || !isFinite(b)) nan++; peak = Math.max(peak, Math.abs(a), Math.abs(b)); }
  // 咔哒声：跳变后 15 ms 内二阶差分的最大值 ÷ 跳变前 30 ms、跳变后 30–60 ms 的最大值
  const d2 = (t0, t1) => { let m = 0; for (let i = Math.max(2, Math.floor(t0 * sr)); i < t1 * sr; i++) m = Math.max(m, Math.abs(L0[i] - 2 * L0[i - 1] + L0[i - 2])); return m; };
  const ev = [['张嘴（门开）', 0.2], ['CUTOFF 150→2500', 0.6], ['CUTOFF 2500→150 + RESO 0.95', 0.9], ['闭嘴（门关）', 1.2], ['60 ms 后又张嘴', 1.26], ['重音', 1.5], ['元音 i 打开', 1.8], ['移调 +7', 2.4], ['闭嘴', 2.8]];
  const rows = ev.map(([k, t]) => { const at = d2(t, t + 0.015), ref = Math.max(d2(t - 0.03, t), d2(t + 0.03, t + 0.06), 1e-4); return [k + ' ' + t.toFixed(2) + ' s', at / ref]; });
  out.textContent = `NaN：${nan}　峰值：${peak.toFixed(3)}（< 1 不削波）\n跳变处 ÷ 前后参照（≤ 1.5 视为没有咔哒声）：\n` + rows.map(([k, q]) => `${k}：${q.toFixed(2)}`).join('\n');
  window.__verify = { nan, peak, rows };
  return window.__verify;
}

/* ---------------- 延迟测试：?video=<文件>&bench=<秒> ----------------
   走完全相同的识别管线；结束后用录下的原始张嘴曲线离线回放不同的滤波参数，量“滤波拖了多少”和“还抖不抖”。 */
const BENCH = Q.has('bench') ? Math.max(5, +Q.get('bench') || 20) : 0;
function startBench() {
  toast('延迟测试：' + BENCH + ' 秒后出报告');
  for (const k of ['inf', 'frameToCtl', 'capToCtl', 'capToDispatch', 'frameWait', 'interval', 'vsync']) D[k].clear();
  TRACE.length = 0; D.frames = 0; D.faces = 0;
  setTimeout(() => {
    const r = benchReport(); window.__bench = r; console.log('[06 bench]', r.summary); $('#vout').textContent = JSON.stringify(r.summary, null, 1);
    // 本机测试用：&post=<名字> 把报告交给 127.0.0.1:8898 的接收脚本（无头 Chrome 跑测试时拿结果）
    if (Q.get('post')) fetch('http://127.0.0.1:8898/' + encodeURIComponent(Q.get('post')), { method: 'POST', body: JSON.stringify(r) }).catch(() => {});
  }, BENCH * 1000);
}
// 一条滤波设置在录下的原始曲线上的表现：
//   上升沿延迟 = 原始越过阈值 → 输出越过阈值（阈值 = 这段视频张嘴范围的中点，p10 与 p90 之间）
//   互相关延迟 = 输出整体比原始晚多少（2 ms 分辨率）；抖动比 = 输出二阶差分 RMS ÷ 原始二阶差分 RMS（越小越稳）
function evalFilter(tr, minCut, beta, lead, dCut = 4) {
  const f = new OneEuro(minCut, beta, dCut), y = tr.map(p => { const v = f.f(p.raw, p.t); return clamp01(v + lead * f.dx); });
  const sr = tr.map(p => p.raw).sort((a, b) => a - b), p10 = sr[Math.floor(sr.length * 0.1)], p90 = sr[Math.floor(sr.length * 0.9)], thr = p10 + 0.5 * (p90 - p10);
  const cross = (arr, i) => tr[i - 1].t + (thr - arr[i - 1]) / Math.max(1e-6, arr[i] - arr[i - 1]) * (tr[i].t - tr[i - 1].t);
  const onsets = [];
  if (p90 - p10 > 0.08) for (let i = 1; i < tr.length; i++) if (tr[i - 1].raw < thr && tr[i].raw >= thr) {
    const ta = cross(tr.map(p => p.raw), i);
    for (let j = i; j < Math.min(tr.length, i + 30); j++) if (y[j] >= thr) { onsets.push(Math.max(0, (y[j - 1] < thr ? cross(y, j) : tr[j].t) - ta) * 1000); break; }
  }
  onsets.sort((a, b) => a - b);
  const t0 = tr[0].t, t1 = tr[tr.length - 1].t, DT = 0.002, n = Math.floor((t1 - t0) / DT);
  const rs = arr => { const o = new Float32Array(n); let j = 0; for (let i = 0; i < n; i++) { const t = t0 + i * DT; while (j < tr.length - 2 && tr[j + 1].t < t) j++; const u = clamp01((t - tr[j].t) / Math.max(1e-6, tr[j + 1].t - tr[j].t)); o[i] = arr[j] + (arr[j + 1] - arr[j]) * u; } return o; };
  const a = rs(tr.map(p => p.raw)), b = rs(y);
  let mA = 0, mB = 0; for (let i = 0; i < n; i++) { mA += a[i]; mB += b[i]; } mA /= n; mB /= n;
  let best = -Infinity, bl = 0; for (let L = 0; L <= 100; L++) { let s = 0; for (let i = 0; i + L < n; i++) s += (a[i] - mA) * (b[i + L] - mB); s /= (n - L); if (s > best) { best = s; bl = L; } }
  const d2 = arr => { let s = 0, c = 0; for (let i = 2; i < arr.length; i++) { const v = arr[i] - 2 * arr[i - 1] + arr[i - 2]; s += v * v; c++; } return Math.sqrt(s / Math.max(1, c)); };
  return { minCut, beta, lead, onsetMs: onsets.length ? +onsets[onsets.length >> 1].toFixed(1) : null, onsets: onsets.length, xcorrMs: bl * DT * 1000, jitter: +(d2(y) / Math.max(1e-6, d2(tr.map(p => p.raw)))).toFixed(3), range: [+p10.toFixed(3), +p90.toFixed(3)] };
}
function benchReport() {
  // 视频里的人没做过校准：用这段视频自己的原始张嘴范围（p5–p98）归一，相当于自动校准一次
  const ros = TRACE.map(p => p.ro).sort((a, b) => a - b), lo = ros[Math.floor(ros.length * 0.05)] || 0, hi = ros[Math.floor(ros.length * 0.98)] || 1;
  const tr = TRACE.map(p => ({ t: p.t, raw: clamp01((p.ro - lo) / Math.max(1e-3, hi - lo)) })), s = snapshot(false), grid = [];
  if (tr.length > 30) for (const mc of [0.6, 1, 1.5, 2.2, 3.2, 5]) for (const be of [0.5, 1.2, 2, 4, 8]) for (const ld of [0, 0.012, 0.025]) grid.push(evalFilter(tr, mc, be, ld));
  grid.sort((a, b) => (a.onsetMs ?? 1e9) - (b.onsetMs ?? 1e9));
  const cur = tr.length > 30 ? evalFilter(tr, fpOpen().mc, fpOpen().beta, FP.lead) : null;
  const old = tr.length > 30 ? evalFilter(tr, lerp(3.0, 0.6, 0.5), 1.2, 0) : null;   // 第一版的参数（跟手↔稳 = 0.5，beta 1.2，不预测）
  return { summary: { roRange: [+lo.toFixed(3), +hi.toFixed(3)], video: S.testVideo, backend: s.backend, fps: s.fps, frames: s.frames, faces: s.faces, inferenceMs: s.inferenceMs, frameToControlMs: s.frameToControlMs,
    frameWaitMs: s.frameWaitMs, frameIntervalMs: s.frameIntervalMs, vsyncDeviationMs: s.vsyncDeviationMs, audio: s.audio, filterNow: cur, filterV1: old }, grid, trace: tr };
}

/* ---------------- 开始 ---------------- */
applyLang(); setVowel(S.vowel); setWave(S.wave); syncGest(); applyBeauty();
if (S.clean) setClean(true);
if (S.testVideo) { $('#intro').hidden = true; initAudio().catch(() => {}); startVideoFile(S.testVideo); }
layout();
requestAnimationFrame(frame);
window.__lip = { S, V, N, R, A, D, FP, AUTO, BEAUTY, BV, PRESETS, buildChain, procOpts, step, tick, onFace, evalFilter, benchReport, snapshot, sanitizeCal, autoBackend, get F() { return F; }, get CAL() { return CAL; }, get TRACE() { return TRACE; } };
window.verify = verify;
