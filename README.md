# Mouth × Acid

Say wow. Play a TB-303-style acid line with your face.

**Try it:** https://visual-interaction-lab.netlify.app/06-lipsync-303/

| Face | Sound |
|---|---|
| Open mouth | CUTOFF |
| Pucker | RESO |
| Smile | ENV / second peak (with "Two peaks" on) |
| Sudden jaw drop or nod | Accent |
| Wink | Next pattern |
| Raise brows | Reverb + delay |

Two modes: **Free talk** (your mouth opens the sound) and **Groove** (a 16-step acid line plays, your mouth plays the filter). Five patterns: Chicago, Raga, Deep, Techno, Minimal. No camera? Use the mouse or a finger.

Video stays on your device and is never uploaded. Headphones recommended.

## 用脸部表情演奏 Acid

张嘴拧 CUTOFF，嘟嘴拧 RESO，咧嘴拧 ENV / 第二个峰；突然张嘴或点头是重音，眨一只眼换音型，挑眉甩混响和延迟。没有摄像头也可以用鼠标或手指拖。画面只在本机处理，不上传。

## Run locally

Any static server works, for example:

```
python -m http.server 8000
```

then open http://localhost:8000/. The camera needs `localhost` or HTTPS.

## How it works

- `face-worker.js` runs Google MediaPipe Face Landmarker in a Web Worker (478 landmarks + blendshapes). The model and WASM are in `lib/mediapipe/`, with the official CDN as fallback.
- `app.js` turns mouth shape into filter parameters (1€ filter, per-user calibration) and draws the mirror and the filter curve.
- `worklet.js` is the sound: an AudioWorklet 303-style voice (4-pole ladder filter, accent, slide), drums, delay, plus a convolution reverb send.
- `beauty.js` is an optional skin-only smoothing pass in WebGL (Settings → Beauty).

Add `?dev` to the URL for gesture toggles, latency stats and an offline sound check.

## Credits

Built by [Electro-Dig](https://github.com/Electro-Dig). Face tracking: [MediaPipe](https://ai.google.dev/edge/mediapipe) (Apache 2.0, see `lib/mediapipe/LICENSE`).

Code in this repository is MIT licensed (see `LICENSE`).
