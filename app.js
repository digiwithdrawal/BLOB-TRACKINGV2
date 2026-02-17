const video = document.getElementById('vid');

// viewport display canvas (letterboxed)
const screen = document.getElementById('screen');
const sctx = screen.getContext('2d', { willReadFrequently: true });

// true output frame (cropped to chosen aspect)
const frame = document.createElement('canvas');
const fctx = frame.getContext('2d', { willReadFrequently: true });

// analysis buffer (small) for motion/blob picking
const ana = document.createElement('canvas');
const actx = ana.getContext('2d', { willReadFrequently: true });

// previous analysis frame
let prevAna = null;

const panel = document.getElementById('panel');
const showHudBtn = document.getElementById('showHud');

const ui = {
  flip: document.getElementById('flip'),
  snap: document.getElementById('snap'),
  rec: document.getElementById('rec'),
  hud: document.getElementById('hud'),
  tip: document.getElementById('tip'),

  format: document.getElementById('format'),
  ink: document.getElementById('ink'),

  t_lines: document.getElementById('t_lines'),
  t_blobs: document.getElementById('t_blobs'),
  t_bloom: document.getElementById('t_bloom'),
  t_ps2: document.getElementById('t_ps2'),
  t_gate: document.getElementById('t_gate'),

  s_amount: document.getElementById('s_amount'),
  s_sens: document.getElementById('s_sens'),
  s_link: document.getElementById('s_link'),
  s_bloom: document.getElementById('s_bloom'),
  s_res: document.getElementById('s_res'),
};

let facingMode = "environment";
let stream = null;

// HUD state
let hudHidden = false;
function setHudHidden(v){
  hudHidden = !!v;
  panel.classList.toggle('hidden', hudHidden);
  showHudBtn.classList.toggle('show', hudHidden);
  ui.hud.textContent = hudHidden ? "SHOW HUD" : "HIDE HUD";
}
setHudHidden(false);

// recording
let recorder = null;
let recChunks = [];
let isRecording = false;

// FaceDetector (optional)
let faceDetector = null;
try {
  if ('FaceDetector' in window) faceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
} catch (_) {
  faceDetector = null;
}
let gateLast = false;
let gateHold = 0; // frames to keep gate true after detection

function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function rand(n=1){ return Math.random()*n; }

function viewportSize(){
  const vw = Math.floor(window.visualViewport?.width || window.innerWidth);
  const vh = Math.floor(window.visualViewport?.height || window.innerHeight);
  return { vw, vh };
}
function deviceIsLandscape(){
  const { vw, vh } = viewportSize();
  return vw > vh;
}
function chosenMode(){
  const m = ui.format.value;
  if (m === 'auto') return deviceIsLandscape() ? 'landscape' : 'portrait';
  return m;
}
function modeAspect(mode){
  if (mode === 'square') return 1;
  if (mode === 'landscape') return 16/9;
  // portrait-ish clamp
  const { vw, vh } = viewportSize();
  return clamp(vw / vh, 9/19.5, 9/14);
}

// Resize pipeline: screen = viewport, frame = chosen aspect at RES
function resizeAll(){
  const { vw, vh } = viewportSize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  screen.width = Math.floor(vw * dpr);
  screen.height = Math.floor(vh * dpr);

  const res = parseInt(ui.s_res.value, 10); // short side target
  const mode = chosenMode();
  const ar = modeAspect(mode);

  let fw, fh;
  if (ar >= 1) { fh = res; fw = Math.round(res * ar); }
  else { fw = res; fh = Math.round(res / ar); }

  frame.width = fw;
  frame.height = fh;

  // analysis buffer fixed small (faster)
  ana.width = 180;
  ana.height = Math.round(180 * (fh / fw));
  prevAna = null;

  ui.tip.innerHTML = `Mode: <b>${mode.toUpperCase()}</b> • Output: <b>${frame.width}×${frame.height}</b> • ${faceDetector ? "Gate supports FaceDetector" : "Gate: limited (no FaceDetector)"}`;
}

// Draw camera cropped to W/H (no stretch)
function drawVideoCoverTo(ctx, W, H){
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const srcA = vw / vh;
  const dstA = W / H;

  let sx=0, sy=0, sW=vw, sH=vh;
  if (srcA > dstA){
    sH = vh;
    sW = vh * dstA;
    sx = (vw - sW) / 2;
  } else {
    sW = vw;
    sH = vw / dstA;
    sy = (vh - sH) / 2;
  }
  ctx.drawImage(video, sx, sy, sW, sH, 0, 0, W, H);
}

// Ink colors
function inkRGBA(){
  switch(ui.ink.value){
    case "ice":   return "rgba(160,220,255,0.95)";
    case "neon":  return "rgba(80,255,140,0.95)";
    case "red":   return "rgba(255,70,70,0.95)";
    case "yellow":return "rgba(255,230,80,0.95)";
    case "white":
    default:      return "rgba(255,255,255,0.95)";
  }
}

// PS2 haze: blue haze + contrast + soft bloom-ish veil
function applyPS2Haze(){
  const W = frame.width, H = frame.height;

  // 1) contrast bump (cheap per-frame)
  const img = fctx.getImageData(0,0,W,H);
  const d = img.data;
  const c = 1.18; // contrast
  const b = 6;    // brightness
  for (let i=0; i<d.length; i+=4){
    d[i]   = clamp((d[i]-128)*c + 128 + b, 0, 255);
    d[i+1] = clamp((d[i+1]-128)*c + 128 + b, 0, 255);
    d[i+2] = clamp((d[i+2]-128)*c + 128 + b, 0, 255);
  }
  fctx.putImageData(img,0,0);

  // 2) blue haze overlay (screen)
  fctx.save();
  fctx.globalCompositeOperation = "screen";
  fctx.globalAlpha = 0.20;
  fctx.fillStyle = "rgb(40,120,255)";
  fctx.fillRect(0,0,W,H);
  fctx.restore();

  // 3) subtle vignette for PS2 vibe
  fctx.save();
  const g = fctx.createRadialGradient(W*0.5,H*0.55, Math.min(W,H)*0.2, W*0.5,H*0.55, Math.max(W,H)*0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.28)");
  fctx.globalAlpha = 1;
  fctx.fillStyle = g;
  fctx.fillRect(0,0,W,H);
  fctx.restore();
}

// Bloom: blurred additive copy of current frame
function applyBloom(strength01){
  const W = frame.width, H = frame.height;
  const blurPx = 6 + strength01 * 18;

  fctx.save();
  fctx.globalCompositeOperation = "screen";
  fctx.globalAlpha = 0.18 + strength01 * 0.42;
  fctx.filter = `blur(${blurPx}px)`;
  fctx.drawImage(frame, 0, 0);
  fctx.filter = "none";
  fctx.restore();
}

// Motion-based blob picking: downsample frame, diff vs prev, pick top points
function computeBlobPoints(){
  // draw frame -> ana
  actx.setTransform(1,0,0,1,0,0);
  actx.imageSmoothingEnabled = true;
  actx.drawImage(frame, 0, 0, ana.width, ana.height);

  const cur = actx.getImageData(0,0,ana.width, ana.height);
  const d = cur.data;

  if (!prevAna){
    prevAna = cur;
    return [];
  }

  const pd = prevAna.data;
  const sens = parseInt(ui.s_sens.value,10) / 100;      // 0..1
  const thr = 18 + (1 - sens) * 36;                     // lower thr = more points
  const amount = parseInt(ui.s_amount.value,10);

  // sample grid (fast)
  const step = 2; // analysis step
  const hits = [];

  for (let y=0; y<ana.height; y+=step){
    for (let x=0; x<ana.width; x+=step){
      const i = (y*ana.width + x)*4;

      const lum  = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
      const plum = 0.2126*pd[i] + 0.7152*pd[i+1] + 0.0722*pd[i+2];

      const diff = Math.abs(lum - plum);
      if (diff > thr){
        // weight by diff
        hits.push({ x, y, w: diff });
      }
    }
  }

  // update prev
  prevAna = cur;

  if (hits.length === 0) return [];

  // pick strongest N, but keep spread by simple thinning
  hits.sort((a,b)=> b.w - a.w);

  const maxN = Math.min(amount, 240);
  const chosen = [];
  const minDist = 4; // in ana pixels

  for (let i=0; i<hits.length && chosen.length<maxN; i++){
    const p = hits[i];
    let ok = true;
    for (let j=0; j<chosen.length; j++){
      const q = chosen[j];
      const dx = p.x - q.x, dy = p.y - q.y;
      if (dx*dx + dy*dy < minDist*minDist){ ok = false; break; }
    }
    if (ok) chosen.push(p);
  }

  // map to frame coords
  const sx = frame.width / ana.width;
  const sy = frame.height / ana.height;

  return chosen.map(p => ({
    x: p.x * sx,
    y: p.y * sy,
    w: p.w
  }));
}

function drawBlobsAndLines(points){
  const W = frame.width, H = frame.height;
  const ink = inkRGBA();

  const showBlobs = ui.t_blobs.checked;
  const showLines = ui.t_lines.checked;

  // line distance threshold
  const link = parseInt(ui.s_link.value,10);
  const link2 = link * link;

  fctx.save();
  fctx.lineCap = "round";
  fctx.lineJoin = "round";
  fctx.strokeStyle = ink;
  fctx.fillStyle = ink;

  // mild glow
  fctx.shadowColor = ink.replace("0.95", "0.75");
  fctx.shadowBlur = 10;

  if (showLines){
    fctx.globalAlpha = 0.75;
    for (let i=0; i<points.length; i++){
      const a = points[i];
      for (let j=i+1; j<points.length; j++){
        const b = points[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < link2){
          const t = 1 - (d2 / link2);
          fctx.globalAlpha = 0.15 + t*0.65;
          fctx.lineWidth = 1 + t*2.2;
          fctx.beginPath();
          fctx.moveTo(a.x, a.y);
          fctx.lineTo(b.x, b.y);
          fctx.stroke();
        }
      }
    }
  }

  if (showBlobs){
    fctx.globalAlpha = 0.95;
    for (let i=0; i<points.length; i++){
      const p = points[i];
      const r = 1.8 + clamp(p.w/40, 0, 6.0);
      fctx.beginPath();
      fctx.arc(p.x, p.y, r, 0, Math.PI*2);
      fctx.fill();
    }
  }

  fctx.restore();
}

// letterboxed contain draw frame -> screen
function drawFrameToScreen(){
  const SW = screen.width, SH = screen.height;
  const FW = frame.width, FH = frame.height;

  const scale = Math.min(SW / FW, SH / FH);
  const dw = Math.round(FW * scale);
  const dh = Math.round(FH * scale);
  const dx = Math.floor((SW - dw) / 2);
  const dy = Math.floor((SH - dh) / 2);

  sctx.save();
  sctx.setTransform(1,0,0,1,0,0);
  sctx.imageSmoothingEnabled = false;
  sctx.fillStyle = "#000";
  sctx.fillRect(0,0,SW,SH);
  sctx.drawImage(frame, 0,0,FW,FH, dx,dy,dw,dh);
  sctx.restore();
}

// Face/person gate (optional)
async function updateGate(){
  if (!ui.t_gate.checked) {
    gateLast = true;
    gateHold = 0;
    return;
  }

  if (!faceDetector){
    // No FaceDetector support: treat as always-on (or you can flip to always-off)
    gateLast = true;
    return;
  }

  // run detector at low frequency
  if (gateHold > 0){
    gateHold--;
    gateLast = true;
    return;
  }

  try{
    const faces = await faceDetector.detect(frame);
    if (faces && faces.length){
      gateLast = true;
      gateHold = 12; // keep on for a short time
    } else {
      gateLast = false;
    }
  }catch(_){
    gateLast = true; // fail open
  }
}

// SNAP photo (true frame)
function snapPhoto(){
  const a = document.createElement('a');
  a.download = `blobtrack_v2_${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
  a.href = frame.toDataURL('image/png');
  a.click();
}

// recording from screen? we want true frame: capture from frame via a dedicated output canvas stream
// easiest: capture from screen (already contains frame). BUT that includes letterbox.
// So: create a recorder canvas same size as frame and draw frame into it each tick (we already have frame).
// Use frame.captureStream().
function startRecording(){
  if (!('MediaRecorder' in window)){
    ui.tip.innerHTML = "MediaRecorder not supported in this browser.";
    return;
  }
  try{
    const fps = 30;
    const stream = frame.captureStream(fps);
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    recChunks = [];
    recorder.ondataavailable = (e)=> { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = ()=>{
      const blob = new Blob(recChunks, { type: recorder.mimeType || "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = `blobtrack_v2_${new Date().toISOString().replace(/[:.]/g,'-')}.webm`;
      a.href = url;
      a.click();
      setTimeout(()=> URL.revokeObjectURL(url), 2500);
    };
    recorder.start();
    isRecording = true;
    ui.rec.textContent = "STOP";
    ui.tip.innerHTML = "Recording… hit STOP to save.";
  }catch(err){
    ui.tip.innerHTML = `Recording failed: ${String(err)}`;
  }
}

function stopRecording(){
  if (recorder && isRecording){
    recorder.stop();
  }
  isRecording = false;
  ui.rec.textContent = "REC";
}

function pickMimeType(){
  const opts = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  for (const t of opts){
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function startCamera(){
  if (stream) stream.getTracks().forEach(t => t.stop());

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });

  video.srcObject = stream;
  await new Promise(res => video.onloadedmetadata = res);

  resizeAll();
  requestAnimationFrame(loop);
}

let gateTicker = 0;

async function loop(){
  // resize when needed (format auto rotation, res changes, viewport changes)
  const mode = chosenMode();
  const key = [
    mode,
    ui.format.value,
    ui.s_res.value,
    (window.visualViewport?.width||0),
    (window.visualViewport?.height||0),
    video.videoWidth, video.videoHeight
  ].join('|');

  if (key !== lastKey){
    lastKey = key;
    resizeAll();
  }

  // 1) camera -> frame cropped
  fctx.setTransform(1,0,0,1,0,0);
  fctx.imageSmoothingEnabled = true;
  drawVideoCoverTo(fctx, frame.width, frame.height);

  // 2) gate update (not every frame)
  gateTicker++;
  if (gateTicker % 8 === 0) await updateGate();

  // 3) compute motion blobs & draw if gated
  if (gateLast){
    const pts = computeBlobPoints();
    drawBlobsAndLines(pts);
  }

  // 4) bloom + ps2 haze overlays (toggles)
  const bloomAmt = parseInt(ui.s_bloom.value,10)/100;
  if (ui.t_bloom.checked && bloomAmt > 0.01) applyBloom(bloomAmt);
  if (ui.t_ps2.checked) applyPS2Haze();

  // 5) push to screen (letterbox contain)
  drawFrameToScreen();

  requestAnimationFrame(loop);
}

/* -------- events -------- */
ui.hud.addEventListener('click', () => setHudHidden(!hudHidden));
showHudBtn.addEventListener('click', () => setHudHidden(false));

ui.snap.addEventListener('click', snapPhoto);

ui.rec.addEventListener('click', () => {
  if (!isRecording) startRecording();
  else stopRecording();
});

ui.flip.addEventListener('click', async () => {
  facingMode = (facingMode === "environment") ? "user" : "environment";
  await startCamera();
});

ui.format.addEventListener('change', () => { lastKey=""; resizeAll(); });
ui.ink.addEventListener('change', () => { /* immediate */ });
ui.s_res.addEventListener('input', () => { lastKey=""; resizeAll(); });

// iOS viewport changes
if (window.visualViewport){
  window.visualViewport.addEventListener('resize', () => { lastKey=""; resizeAll(); });
  window.visualViewport.addEventListener('scroll', () => { lastKey=""; resizeAll(); });
}
window.addEventListener('orientationchange', () => { lastKey=""; resizeAll(); });
window.addEventListener('resize', () => { lastKey=""; resizeAll(); });

/* -------- boot -------- */
(async () => {
  try{
    ui.tip.innerHTML = `AUTO flips with rotation • REC saves true crop • Gate: ${faceDetector ? "FaceDetector" : "fallback"}`;
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
