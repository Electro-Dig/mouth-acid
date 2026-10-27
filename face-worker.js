/* 对口型 303 · 识别 Worker（经典 Worker：MediaPipe 的 WASM 加载器要用 importScripts）。
   做法照 D:\Codex\air-cello-prototype\public\inference-worker.js：主线程最多只让一帧在路上，永远送最新的一帧。
   GPU 和 CPU 两个后端都能建：桌面上 GPU 推理可能被屏幕刷新节拍卡住（实测 33 ms ≈ 2 × 16.7），CPU（XNNPACK）不会，主线程实测后挑快的。
   init：{srcs:[{js,wasm,model,name}], delegates:['CPU','GPU']} → ready {backend, src, warm}（建第一个能建的）
   add：{delegate} → added {backend, ok, warm, message}
   frame：{bitmap, ts, id, d} → result {id, d, pts: Float32Array(x,y 交错) | null, bs: {名字: 分数}, inference} */
// MediaPipe 的 WASM 打日志时会调全局 dbg()，正式版里没定义 → “dbg is not a function”
self.dbg = () => {};
const BS = ['mouthPucker', 'mouthFunnel', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen'];
const models = {}, lastTs = {};
let mp = null, files = null, srcName = '', modelPath = '', first = null;
async function create(delegate) {
  const opts = { baseOptions: { modelAssetPath: modelPath, delegate }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5 };
  if (delegate === 'GPU') opts.canvas = new OffscreenCanvas(640, 480);
  const m = await mp.FaceLandmarker.createFromOptions(files, opts);
  // 预热：GPU 第一次识别要编译着色器（1–2 秒），放在加载阶段
  const c = new OffscreenCanvas(64, 48); c.getContext('2d').fillRect(0, 0, 64, 48);
  lastTs[delegate] = 1; const t0 = performance.now(); m.detectForVideo(c, lastTs[delegate]);
  models[delegate] = m;
  return performance.now() - t0;
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      let err = null;
      for (const src of data.srcs) {
        try { mp = await import(src.js); files = await mp.FilesetResolver.forVisionTasks(src.wasm); srcName = src.name; modelPath = src.model; } catch (e) { err = e; mp = null; continue; }
        for (const d of data.delegates) {
          try { const warm = await create(d); first = d; self.postMessage({ type: 'ready', backend: d, src: srcName, warm }); return; }
          catch (e) { err = e; }
        }
      }
      throw err || new Error('init failed');
    }
    if (data.type === 'add') {
      try { const warm = models[data.delegate] ? 0 : await create(data.delegate); self.postMessage({ type: 'added', backend: data.delegate, ok: true, warm }); }
      catch (e) { self.postMessage({ type: 'added', backend: data.delegate, ok: false, message: String((e && e.message) || e) }); }
      return;
    }
    if (data.type === 'frame') {
      const d = models[data.d] ? data.d : first, model = models[d];
      const t0 = performance.now(), ts = Math.max((lastTs[d] || 0) + 1, Math.round(data.ts)); lastTs[d] = ts;
      let r;
      try { r = model.detectForVideo(data.bitmap, ts); } finally { data.bitmap.close(); }
      const inference = performance.now() - t0;
      const lm = r.faceLandmarks && r.faceLandmarks[0];
      let pts = null; const bs = {};
      if (lm) {
        pts = new Float32Array(lm.length * 2);
        for (let i = 0; i < lm.length; i++) { pts[2 * i] = lm[i].x; pts[2 * i + 1] = lm[i].y; }
        const cats = r.faceBlendshapes && r.faceBlendshapes[0] && r.faceBlendshapes[0].categories;
        if (cats) for (const c of cats) if (BS.includes(c.categoryName)) bs[c.categoryName] = c.score;
      }
      self.postMessage({ type: 'result', id: data.id, d, pts, bs, inference }, pts ? [pts.buffer] : []);
    }
  } catch (e) { self.postMessage({ type: 'error', id: data && data.id, message: String((e && e.message) || e) }); }
};
