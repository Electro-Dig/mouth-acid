/* 对口型 303 · 美颜（WebGL，一次画完，不下载任何模型）
   1. 皮肤蒙版：用识别已经给出的 478 个人脸关键点，在一张 160×120 的小画布上画脸部轮廓，抠掉眼睛、眉毛、嘴唇，边缘羽化。
      只有蒙版里的皮肤会被处理：背景、头发、衣服、眼镜都不动；嘴唇不在蒙版里，唇线和识别都不受影响。
   2. 保边磨皮：16 个采样点的双边滤波（离得近、颜色也接近的才平均），眼镜框、眉毛这种颜色差得大的边缘留着。
   3. 留一点纹理：结果 = 平滑 + (原图 − 平滑) × detail（高低频分离的简化版），不会变成“塑料脸”。
   4. 肤色：轻微提亮 + 一点红润，只在蒙版里。
   用法：const b = createBeauty(canvas); b.setMask(LM, vw, vh) 每次有新关键点；b.render(video, map, params) 每帧。 */

const VS = `attribute vec2 p; varying vec2 s;
void main() { s = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `precision mediump float;
varying vec2 s;
uniform sampler2D uVid, uMask;
uniform vec4 uMap;      // 画布坐标 → 视频坐标（object-fit: cover + 镜像）：x = kx·(1−sx) + ox，y = ky·sy + oy
uniform vec2 uTex;      // 1 / 视频宽高
uniform float uR, uStr, uDetail, uBright, uWarm;
uniform vec2 uOff[16];
void main() {
  vec2 uv = vec2(uMap.x * (1.0 - s.x) + uMap.y, uMap.z * s.y + uMap.w);
  vec3 c = texture2D(uVid, uv).rgb;
  float m = texture2D(uMask, uv).r * uStr;
  if (m < 0.004) { gl_FragColor = vec4(c, 1.0); return; }
  vec3 sum = c; float ws = 1.0;
  for (int i = 0; i < 16; i++) {
    vec3 q = texture2D(uVid, uv + uOff[i] * uR * uTex).rgb, d = q - c;
    float w = exp(-dot(d, d) * 60.0) * exp(-dot(uOff[i], uOff[i]) * 1.2);   // 颜色差 0.1 → 0.55，0.25 → 0.02：边缘不参与平均
    sum += q * w; ws += w;
  }
  vec3 sm = sum / ws;
  vec3 b = sm + (c - sm) * uDetail;
  b += (1.0 - b) * uBright;
  b.r += uWarm; b.b -= uWarm * 0.5;
  gl_FragColor = vec4(mix(c, clamp(b, 0.0, 1.0), m), 1.0);
}`;

// 关键点（MediaPipe Face Mesh 序号）
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_L = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const EYE_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const BROW_L = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336];
const BROW_R = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107];
const LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];

export function createBeauty(canvas) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const pg = gl.createProgram();
  try { gl.attachShader(pg, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, FS)); } catch (e) { console.warn('[beauty]', e); return null; }
  gl.linkProgram(pg); if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) return null;
  gl.useProgram(pg);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const ap = gl.getAttribLocation(pg, 'p'); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
  const U = n => gl.getUniformLocation(pg, n);
  const u = { vid: U('uVid'), mask: U('uMask'), map: U('uMap'), tex: U('uTex'), r: U('uR'), str: U('uStr'), detail: U('uDetail'), bright: U('uBright'), warm: U('uWarm'), off: U('uOff') };
  // 16 个采样点：黄金角螺旋，铺满单位圆
  const off = new Float32Array(32); for (let i = 0; i < 16; i++) { const r = Math.sqrt((i + 0.5) / 16), a = i * 2.39996; off[2 * i] = r * Math.cos(a); off[2 * i + 1] = r * Math.sin(a); }
  gl.uniform2fv(u.off, off); gl.uniform1i(u.vid, 0); gl.uniform1i(u.mask, 1);
  const mkTex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t; };
  const tVid = mkTex(), tMask = mkTex();
  // 蒙版画在视频坐标里（不镜像），小尺寸 + 模糊 = 羽化
  const mk = document.createElement('canvas'); mk.width = 160; mk.height = 120; const mg = mk.getContext('2d');
  const blurOK = 'filter' in mg;
  const mk2 = document.createElement('canvas'); mk2.width = 160; mk2.height = 120; const mg2 = mk2.getContext('2d');
  let maskDirty = true, hasMask = false;
  function setMask(LM, vw, vh) {
    mg.fillStyle = '#000'; mg.fillRect(0, 0, 160, 120);
    if (LM) {
      const W = 160, H = 120, poly = (idx, fill) => { mg.beginPath(); idx.forEach((j, n) => { const x = LM[2 * j] * W, y = LM[2 * j + 1] * H; n ? mg.lineTo(x, y) : mg.moveTo(x, y); }); mg.closePath(); if (fill) mg.fill(); };
      const iod = Math.hypot((LM[66] - LM[526]) * W, (LM[67] - LM[527]) * H);   // 两眼外角距离，用来定眼睛 / 眉毛挖掉多宽
      mg.fillStyle = '#fff'; poly(OVAL, true);
      mg.fillStyle = '#000'; mg.strokeStyle = '#000'; mg.lineJoin = 'round';
      for (const [idx, grow] of [[EYE_L, 0.16], [EYE_R, 0.16], [BROW_L, 0.1], [BROW_R, 0.1], [LIPS, 0.06]]) { poly(idx, true); mg.lineWidth = Math.max(1, iod * grow); mg.stroke(); }
    }
    hasMask = !!LM; maskDirty = true;
  }
  function render(video, map, p) {
    const W = canvas.width, H = canvas.height;
    if (!video.videoWidth || video.readyState < 2) return false;
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tVid);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video); } catch (e) { return false; }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tMask);
    if (maskDirty) {
      maskDirty = false;
      let src = mk;
      if (blurOK) { mg2.filter = 'blur(2.5px)'; mg2.clearRect(0, 0, 160, 120); mg2.drawImage(mk, 0, 0); mg2.filter = 'none'; src = mk2; }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    }
    gl.uniform4f(u.map, map.kx, map.ox, map.ky, map.oy);
    gl.uniform2f(u.tex, 1 / video.videoWidth, 1 / video.videoHeight);
    gl.uniform1f(u.r, p.radius); gl.uniform1f(u.str, hasMask ? p.strength : 0); gl.uniform1f(u.detail, p.detail); gl.uniform1f(u.bright, p.bright); gl.uniform1f(u.warm, p.warm);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
  return { setMask, render, mask: mk };
}
