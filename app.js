// BlobTrack Cam V2
// - TouchDesigner-ish blob tracking overlay
// - Overlay color selector
// - Portrait/Landscape/Square format render (snap/rec matches)
// - Bloom toggle + strength
// - Face Gate toggle (FaceDetector if available)
// - Video record (canvas capture) when supported

const video = document.getElementById('v');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const ui = {
  flip:  document.getElementById('flip'),
  rec:   document.getElementById('rec'),
  snap:  document.getElementById('snap'),
  reset: document.getElementById('reset'),
  tip:   document.getElementById('tip'),

  t_boxes:  document.getElementById('t_boxes'),
  t_coords: document.getElementById('t_coords'),
  t_lines:  document.getElementById('t_lines'),
  t_trails: document.getElementById('t_trails'),

  t_bloom:  document.getElementById('t_bloom'),
  t_face:   document.getElementById('t_face'),

  color:  document.getElementById('color'),
  format: document.getElementById('format'),

  amount: document.getElementById('amount'),
  thresh: document.getElementById('thresh'),
  scale:  document.getElementById('scale'),
  bloom:  document.getElementById('bloom'),
};

let facingMode = "environment";
let stream = null;

// analysis canvas (low-res) for blob detection
const a = document.createElement('canvas');
const actx = a.getContext('2d', { willReadFrequently: true });

// bloom buffer (same size as output)
const b = document.createElement('canvas');
const bctx = b.getContext('2d', { willReadFrequently: true });

let prevGray = null;

// trails buffer control
let trailFade = 0.18; // lower = longer trails

// recording
let recorder = null;
let chunks = [];
let isRec = false;

// face gating
let faceDetector = null;
let faceBoxes = [];
let faceBusy = false;
let faceFrameCounter = 0;
let faceSupportChecked = false;

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function setTip(html){ ui.tip.innerHTML = html; }
function nowStamp(){
  return new Date().toISOString().replace(/[:.]/g,'-');
}

function pickMimeType(){
  if (!window.MediaRecorder) return '';
  const opts = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4'
  ];
  return opts.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

/* ---------------- Format Rendering ---------------- */

function drawCover(targetCtx, dx, dy, dW, dH){
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;

  const srcAspect = vw / vh;
  const dstAspect = dW / dH;

  let sx=0, sy=0, sW=vw, sH=vh;
  if (srcAspect > dstAspect){
    sH = vh;
    sW = vh * dstAspect;
    sx = (vw - sW) / 2;
  } else {
    sW = vw;
    sH = vw / dstAspect;
    sy = (vh - sH) / 2;
  }

  targetCtx.drawImage(video, sx, sy, sW, sH, dx, dy, dW, dH);
}

function drawFormatted(targetCtx, W, H, format){
  targetCtx.save();
  targetCtx.setTransform(1,0,0,1,0,0);
  targetCtx.clearRect(0,0,W,H);

  if (format === 'portrait'){
    drawCover(targetCtx, 0, 0, W, H);
  } else if (format === 'square'){
    drawCover(targetCtx, 0, 0, W, H);
  } else {
    // landscape: rotate output 90deg so it truly becomes landscape render
    targetCtx.translate(W/2, H/2);
    targetCtx.rotate(Math.PI/2);
    // rotated space uses swapped dims (H, W)
    drawCover(targetCtx, -H/2, -W/2, H, W);
  }

  targetCtx.restore();
}

function desiredOutputSize(){
  const base = parseInt(ui.scale.value, 10);
  const format = ui.format.value;

  const outW = base * 2;
  let outH;

  if (format === 'square'){
    outH = outW;
  } else if (format === 'landscape'){
    outH = Math.max(200, Math.round(outW * 0.5625)); // ~16:9
  } else {
    // portrait: use camera aspect for best matching
    const aspect = (video.videoHeight / video.videoWidth) || (16/9);
    outH = Math.max(200, Math.round(outW * aspect));
  }

  return { outW, outH };
}

function resizePipes(){
  const { outW, outH } = desiredOutputSize();

  canvas.width = outW;
  canvas.height = outH;

  // analysis canvas lower res for speed
  a.width = parseInt(ui.scale.value, 10);
  a.height = Math.max(120, Math.round((canvas.height / canvas.width) * a.width));

  // bloom buffer
  b.width = canvas.width;
  b.height = canvas.height;

  prevGray = new Float32Array(a.width * a.height);

  // reset faces (since coords mapping changed)
  faceBoxes = [];
}

/* ---------------- Overlay Color ---------------- */

function overlayColor(){
  const c = ui.color.value;
  if (c === 'white')  return { stroke:'rgba(255,255,255,0.92)', fill:'rgba(255,255,255,0.96)' };
  if (c === 'blue')   return { stroke:'rgba(116,247,255,0.88)', fill:'rgba(116,247,255,0.95)' };
  if (c === 'green')  return { stroke:'rgba(70,255,90,0.88)',   fill:'rgba(70,255,90,0.95)' };
  if (c === 'red')    return { stroke:'rgba(255,60,60,0.88)',   fill:'rgba(255,60,60,0.95)' };
  return              { stroke:'rgba(255,230,80,0.88)',  fill:'rgba(255,230,80,0.95)' }; // yellow
}

/* ---------------- Blob Detection ---------------- */

function grayFromRGBA(r,g,b){
  return (0.2126*r + 0.7152*g + 0.0722*b) / 255;
}

function detectBlobs(){
  const w = a.width, h = a.height;
  const format = ui.format.value;

  drawFormatted(actx, w, h, format);
  const img = actx.getImageData(0,0,w,h);
  const d = img.data;

  const amount = parseInt(ui.amount.value,10) / 100; // 0..1
  const thresh = parseInt(ui.thresh.value,10) / 100; // 0..1

  const maxBlobs = Math.floor(5 + amount * 85);       // 5..90
  const motionMix = 0.25 + amount * 0.65;             // 0.25..0.90
  const cell = Math.max(2, Math.floor(6 - amount * 4));// 6..2
  const radius = 10 + amount * 28;                    // cluster radius
  const r2 = radius * radius;

  // Gather hot points (sampled by grid)
  const hot = [];
  let idx = 0;

  for (let y=0; y<h; y++){
    for (let x=0; x<w; x++){
      const i = idx * 4;
      const g = grayFromRGBA(d[i], d[i+1], d[i+2]);
      const m = Math.abs(g - prevGray[idx]);
      prevGray[idx] = g;

      // combine brightness+motion
      const score = g*(1-motionMix) + m*motionMix;

      if (score > thresh && (x % cell === 0) && (y % cell === 0)){
        hot.push({ x, y, s: score });
      }
      idx++;
    }
  }

  hot.sort((A,B) => B.s - A.s);

  // Cheap clustering into blobs
  const blobs = [];
  for (let k=0; k<hot.length && blobs.length < maxBlobs; k++){
    const p = hot[k];

    let found = -1;
    for (let bi=0; bi<blobs.length; bi++){
      const b = blobs[bi];
      const dx = p.x - b.cx;
      const dy = p.y - b.cy;
      if (dx*dx + dy*dy < r2){ found = bi; break; }
    }

    if (found === -1){
      blobs.push({ minx:p.x, miny:p.y, maxx:p.x, maxy:p.y, cx:p.x, cy:p.y, s:p.s, n:1 });
    } else {
      const b = blobs[found];
      b.minx = Math.min(b.minx, p.x); b.miny = Math.min(b.miny, p.y);
      b.maxx = Math.max(b.maxx, p.x); b.maxy = Math.max(b.maxy, p.y);
      b.cx = (b.cx*b.n + p.x) / (b.n+1);
      b.cy = (b.cy*b.n + p.y) / (b.n+1);
      b.s = Math.max(b.s, p.s);
      b.n++;
    }
  }

  // Rank by cluster size + strength
  blobs.sort((A,B) => (B.n + B.s*10) - (A.n + A.s*10));
  return blobs.slice(0, maxBlobs);
}

/* ---------------- Face Gate (optional) ---------------- */

function initFaceDetectorOnce(){
  if (faceSupportChecked) return;
  faceSupportChecked = true;

  if (!('FaceDetector' in window)){
    faceDetector = null;
    setTip("Face Gate: not supported on this browser (FaceDetector missing).");
    return;
  }

  try{
    faceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 3 });
    setTip("Face Gate ready. Turn it on to only show blobs when a face is detected.");
  }catch(e){
    faceDetector = null;
    setTip("Face Gate unavailable on this browser build.");
  }
}

async function updateFacesThrottled(){
  if (!ui.t_face.checked) return;
  initFaceDetectorOnce();
  if (!faceDetector) return;

  // throttle: every 10 frames
  faceFrameCounter++;
  if (faceFrameCounter % 10 !== 0) return;
  if (faceBusy) return;

  faceBusy = true;
  try{
    // ensure analysis canvas has latest formatted frame
    drawFormatted(actx, a.width, a.height, ui.format.value);
    const faces = await faceDetector.detect(a);
    faceBoxes = faces.map(f => f.boundingBox);
  }catch(e){
    faceBoxes = [];
  } finally {
    faceBusy = false;
  }
}

function passFaceGate(){
  if (!ui.t_face.checked) return true;
  if (!faceDetector) return true; // graceful: still show blobs
  return faceBoxes.length > 0;
}

/* ---------------- Bloom ---------------- */

function applyBloom(){
  if (!ui.t_bloom.checked) return;

  const strength = parseInt(ui.bloom.value,10) / 100; // 0..1
  if (strength <= 0.01) return;

  // copy current output into bloom buffer
  bctx.setTransform(1,0,0,1,0,0);
  bctx.clearRect(0,0,b.width,b.height);
  bctx.drawImage(canvas, 0, 0);

  // screen blend blurred buffer back onto output
  const blurA = 4 + strength * 16;
  const blurB = Math.max(2, blurA * 0.55);

  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  ctx.globalAlpha = 0.55 * strength;
  ctx.filter = `blur(${blurA}px)`;
  ctx.drawImage(b, 0, 0);

  ctx.globalAlpha = 0.25 * strength;
  ctx.filter = `blur(${blurB}px)`;
  ctx.drawImage(b, 0, 0);

  ctx.restore();
}

/* ---------------- Draw Overlay ---------------- */

function drawOverlay(blobs){
  const W = canvas.width, H = canvas.height;
  const w = a.width, h = a.height;
  const format = ui.format.value;
  const col = overlayColor();

  // base frame
  if (!ui.t_trails.checked){
    drawFormatted(ctx, W, H, format);
  } else {
    ctx.save();
    ctx.globalAlpha = trailFade;
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fillRect(0,0,W,H);
    ctx.restore();
    drawFormatted(ctx, W, H, format);
  }

  // face gating
  if (!passFaceGate()){
    applyBloom();
    return;
  }

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.lineWidth = 2;
  ctx.strokeStyle = col.stroke;
  ctx.fillStyle = col.fill;
  ctx.font = '700 14px ui-monospace, Menlo, Monaco, Consolas, monospace';

  // connecting lines
  if (ui.t_lines.checked && blobs.length > 1){
    ctx.beginPath();
    for (let i=0; i<blobs.length; i++){
      const b = blobs[i];
      const x = (b.cx / w) * W;
      const y = (b.cy / h) * H;
      if (i === 0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }

  // boxes + coords + crosshair
  for (let i=0; i<blobs.length; i++){
    const b = blobs[i];

    const x0 = (b.minx / w) * W;
    const y0 = (b.miny / h) * H;
    const x1 = (b.maxx / w) * W;
    const y1 = (b.maxy / h) * H;

    const cx = (b.cx / w) * W;
    const cy = (b.cy / h) * H;

    const pad = 8;
    const bx0 = x0 - pad, by0 = y0 - pad, bw = (x1-x0) + pad*2, bh = (y1-y0) + pad*2;

    if (ui.t_boxes.checked){
      ctx.strokeRect(bx0, by0, bw, bh);
    }

    if (ui.t_coords.checked){
      const nx = (b.cx / w).toFixed(5);
      const ny = (b.cy / h).toFixed(5);
      ctx.fillText(`${nx}, ${ny}`, bx0 + 6, by0 - 6);
    }

    ctx.beginPath();
    ctx.moveTo(cx-6, cy); ctx.lineTo(cx+6, cy);
    ctx.moveTo(cx, cy-6); ctx.lineTo(cx, cy+6);
    ctx.stroke();
  }

  // optional face boxes (dashed)
  if (ui.t_face.checked && faceDetector && faceBoxes.length){
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([6,6]);
    for (const fb of faceBoxes){
      const fx = (fb.x / w) * W;
      const fy = (fb.y / h) * H;
      const fw = (fb.width / w) * W;
      const fh = (fb.height / h) * H;
      ctx.strokeRect(fx, fy, fw, fh);
    }
    ctx.restore();
  }

  ctx.restore();

  applyBloom();
}

/* ---------------- Snap + Record ---------------- */

function snap(){
  const aTag = document.createElement('a');
  aTag.download = `blobtrack_v2_${nowStamp()}.png`;
  aTag.href = canvas.toDataURL('image/png');
  aTag.click();
}

async function startRec(){
  if (!window.MediaRecorder){
    setTip("REC not supported here. Try desktop Chrome/Edge for guaranteed recording.");
    return;
  }

  const mimeType = pickMimeType();
  if (!mimeType){
    setTip("REC: no supported video format found on this browser.");
    return;
  }

  try{
    const out = canvas.captureStream(30); // processed output
    recorder = new MediaRecorder(out, { mimeType });
    chunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const aTag = document.createElement('a');
      aTag.href = url;
      aTag.download = `blobtrack_v2_${nowStamp()}.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
      aTag.click();
      setTimeout(() => URL.revokeObjectURL(url), 6000);
    };

    recorder.start(200);
    isRec = true;
    ui.rec.textContent = 'STOP';
    ui.rec.classList.add('warn');
    setTip(`Recording… (${mimeType})`);
  }catch(e){
    console.error(e);
    setTip("Recording failed on this device/browser. Live effect still works.");
  }
}

function stopRec(){
  if (!recorder) return;
  recorder.stop();
  isRec = false;
  ui.rec.textContent = 'REC';
  ui.rec.classList.remove('warn');
  setTip("Saved recording (if supported).");
}

/* ---------------- Reset ---------------- */

function resetTracker(){
  if (prevGray) prevGray.fill(0);
  faceBoxes = [];
  setTip("Tracker reset.");
}

/* ---------------- Main Loop ---------------- */

let lastSizeKey = '';

async function loop(){
  // resize if scale/format changed (cheap key check)
  const key = `${ui.scale.value}|${ui.format.value}|${video.videoWidth}x${video.videoHeight}`;
  if (key !== lastSizeKey){
    lastSizeKey = key;
    resizePipes();
    resetTracker();
  }

  await updateFacesThrottled();

  const blobs = detectBlobs();
  drawOverlay(blobs);

  requestAnimationFrame(loop);
}

/* ---------------- Events ---------------- */

ui.flip.addEventListener('click', async () => {
  facingMode = (facingMode === "environment") ? "user" : "environment";
  await startCamera();
});

ui.snap.addEventListener('click', snap);

ui.reset.addEventListener('click', resetTracker);

ui.rec.addEventListener('click', async () => {
  if (!isRec) await startRec();
  else stopRec();
});

// If Face Gate toggled on, initialize detector check once
ui.t_face.addEventListener('change', () => {
  if (ui.t_face.checked) initFaceDetectorOnce();
});

/* ---------------- Start Camera ---------------- */

async function startCamera(){
  if (stream) stream.getTracks().forEach(t => t.stop());

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });

  video.srcObject = stream;
  await new Promise(res => video.onloadedmetadata = res);

  lastSizeKey = '';
  resizePipes();
  requestAnimationFrame(loop);
}

// Boot
(async () => {
  try{
    await startCamera();
  }catch(err){
    document.body.innerHTML = `
      <div style="padding:20px;font-family:system-ui;color:#fff">
        <h2>Camera blocked</h2>
        <p>Open in <b>Safari</b>, allow Camera permissions, and make sure you’re on <b>HTTPS</b>.</p>
        <pre style="white-space:pre-wrap;color:#bbb">${String(err)}</pre>
      </div>
    `;
    console.error(err);
  }
})();
