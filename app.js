/* BlobTrack Cam V2 — ratio pipeline + bloom + PS2 haze
   - Uses a TRUE output canvas "frame" sized to chosen aspect ratio
   - Displays letterboxed onto "screen" (no stretching)
   - SNAP saves true crop
   - REC records true crop (frame.captureStream)
   - START overlay ensures iOS permission prompt happens
*/

const overlay = document.getElementById('startOverlay');
const startBtn = document.getElementById('startBtn');
const errBox   = document.getElementById('errBox');

function logErr(msg){
  errBox.textContent = (errBox.textContent ? errBox.textContent + "\n\n" : "") + msg;
}
function clearErr(){ errBox.textContent = ""; }

const video  = document.getElementById('vid');
const screen = document.getElementById('screen');
const sctx   = screen.getContext('2d', { willReadFrequently: true });

// True output canvas (not in DOM)
const frame = document.createElement('canvas');
const fctx  = frame.getContext('2d', { willReadFrequently: true });

// Analysis buffer for motion points
const ana = document.createElement('canvas');
const actx = ana.getContext('2d', { willReadFrequently: true });
let prevAna = null;

const panel = document.getElementById('panel');
const showHudBtn = document.getElementById('showHud');

const ui = {
  flip: document.getElementById('flip'),
  snap: document.getElementById('snap'),
  rec:  document.getElementById('rec'),
  hud:  document.getElementById('hud'),
  tip:  document.getElementById('tip'),

  format: document.getElementById('format'),
  ink:    document.getElementById('ink'),

  t_lines: document.getElementById('t_lines'),
  t_blobs: document.getElementById('t_blobs'),
  t_bloom: document.getElementById('t_bloom'),
  t_ps2:   document.getElementById('t_ps2'),

  s_amount: document.getElementById('s_amount'),
  s_sens:   document.getElementById('s_sens'),
  s_link:   document.getElementById('s_link'),
  s_bloom:  document.getElementById('s_bloom'),
  s_res:    document.getElementById('s_res'),
};

let facingMode = "environment";
let stream = null;
let lastKey = "";

// HUD hide/show
let hudHidden = false;
function setHudHidden(v){
  hudHidden = !!v;
  panel.classList.toggle('hidden', hudHidden);
  showHudBtn.classList.toggle('show', hudHidden);
  ui.hud.textContent = hudHidden ? "SHOW HUD" : "HIDE HUD";
}
setHudHidden(false);

// Recording
let recorder = null;
let recChunks = [];
let isRecording = false;

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
  if (m === "auto") return deviceIsLandscape() ? "landscape" : "portrait";
  return m;
}
function modeAspect(mode){
  if (mode === "square") return 1;
  if (mode === "landscape") return 16/9;
  // portrait-ish clamp
  const { vw, vh } = viewportSize();
  return clamp(vw / vh, 9/19.5, 9/14);
}

function resizeAll(){
  const { vw, vh } = viewportSize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  // screen = viewport
  screen.width  = Math.floor(vw * dpr);
  screen.height = Math.floor(vh * dpr);

  // frame = true crop aspect
  const res = parseInt(ui.s_res.value, 10); // short side
  const mode = chosenMode();
  const ar = modeAspect(mode);

  let fw, fh;
  if (ar >= 1){ fh = res; fw = Math.round(res * ar); }
  else { fw = res; fh = Math.round(res / ar); }

  frame.width = fw;
  frame.height = fh;

  // analysis buffer (small and fast, same-ish aspect)
  ana.width = 200;
  ana.height = Math.max(100, Math.round(200 * (fh / fw)));
  prevAna = null;

  ui.tip.innerHTML = `Mode: <b>${mode.toUpperCase()}</b> • Output: <b>${fw}×${fh}</b>`;
}

// Draw video cropped-to-fit into ctx (no stretch)
function drawVideoCoverTo(ctx, W, H){
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const srcA = vw / vh;
  const dstA = W / H;

  let sx=0, sy=0, sW=vw, sH=vh;
  if (srcA > dstA){
    sH = vh;
    sW = vh * dstA;
    sx = (vw - sW)/2;
  } else {
    sW = vw;
    sH = vw / dstA;
    sy = (vh - sH)/2;
  }
  ctx.drawImage(video, sx, sy, sW, sH, 0, 0, W, H);
}

// Letterbox contain draw frame -> screen
function drawFrameToScreen(){
  const SW = screen.width, SH = screen.height;
  const FW = frame.width,  FH = frame.height;

  const scale = Math.min(SW / FW, SH / FH);
  const dw = Math.round(FW * scale);
  const dh = Math.round(FH * scale);
  const dx = Math.floor((SW - dw)/2);
  const dy = Math.floor((SH - dh)/2);

  sctx.save();
  sctx.setTransform(1,0,0,1,0,0);
  sctx.imageSmoothingEnabled = false;
  sctx.fillStyle = "#000";
  sctx.fillRect(0,0,SW,SH);
  sctx.drawImage(frame, 0,0,FW,FH, dx,dy,dw,dh);
  sctx.restore();
}

// Ink palette
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

// Motion sampling -> points (TouchDesigner-ish)
function computeBlobPoints(){
  // frame -> analysis
  actx.imageSmoothingEnabled = true;
  actx.drawImage(frame, 0, 0, ana.width, ana.height);

  const cur = actx.getImageData(0,0,ana.width, ana.height);
  const d = cur.data;

  if (!prevAna){
    prevAna = cur;
    return [];
  }
  const pd = prevAna.data;

  const sens = parseInt(ui.s_sens.value,10)/100;
  const thr = 16 + (1 - sens) * 42;   // lower = more sensitive
  const amount = parseInt(ui.s_amount.value,10);

  const step = 2;
  const hits = [];

  for (let y=0; y<ana.height; y+=step){
    for (let x=0; x<ana.width; x+=step){
      const i = (y*ana.width + x)*4;
      const lum  = 0.2126*d[i]  + 0.7152*d[i+1]  + 0.0722*d[i+2];
      const plum = 0.2126*pd[i] + 0.7152*pd[i+1] + 0.0722*pd[i+2];
      const diff = Math.abs(lum - plum);
      if (diff > thr) hits.push({ x, y, w: diff });
    }
  }

  prevAna = cur;
  if (!hits.length) return [];

  hits.sort((a,b)=> b.w - a.w);

  // thin for spacing
  const chosen = [];
  const maxN = Math.min(amount, 260);
  const minDist = 4;

  for (let i=0; i<hits.length && chosen.length<maxN; i++){
    const p = hits[i];
    let ok = true;
    for (const q of chosen){
      const dx = p.x - q.x, dy = p.y - q.y;
      if (dx*dx + dy*dy < minDist*minDist){ ok = false; break; }
    }
    if (ok) chosen.push(p);
  }

  const sx = frame.width / ana.width;
  const sy = frame.height / ana.height;

  return chosen.map(p => ({ x: p.x*sx, y: p.y*sy, w: p.w }));
}

function drawBlobsAndLines(points){
  const ink = inkRGBA();
  const link = parseInt(ui.s_link.value,10);
  const link2 = link * link;

  fctx.save();
  fctx.lineCap="round";
  fctx.lineJoin="round";
  fctx.strokeStyle = ink;
  fctx.fillStyle = ink;

  // subtle glow
  fctx.shadowColor = ink.replace("0.95", "0.70");
  fctx.shadowBlur = 10;

  if (ui.t_lines.checked){
    for (let i=0; i<points.length; i++){
      const a = points[i];
      for (let j=i+1; j<points.length; j++){
        const b = points[j];
        const dx=a.x-b.x, dy=a.y-b.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < link2){
          const t = 1 - d2/link2;
          fctx.globalAlpha = 0.12 + t*0.70;
          fctx.lineWidth = 1 + t*2.2;
          fctx.beginPath();
          fctx.moveTo(a.x,a.y);
          fctx.lineTo(b.x,b.y);
          fctx.stroke();
        }
      }
    }
  }

  if (ui.t_blobs.checked){
    fctx.globalAlpha = 0.95;
    for (const p of points){
      const r = 1.6 + clamp(p.w/40, 0, 6.5);
      fctx.beginPath();
      fctx.arc(p.x,p.y,r,0,Math.PI*2);
      fctx.fill();
    }
  }

  fctx.restore();
}

// Bloom (simple screen-blur pass)
function applyBloom(strength01){
  const blurPx = 6 + strength01 * 18;
  fctx.save();
  fctx.globalCompositeOperation = "screen";
  fctx.globalAlpha = 0.16 + strength01 * 0.48;
  fctx.filter = `blur(${blurPx}px)`;
  fctx.drawImage(frame, 0, 0);
  fctx.filter = "none";
  fctx.restore();
}

// PS2 Haze: high-contrast + blue fog veil
function applyPS2Haze(){
  const W = frame.width, H = frame.height;

  // contrast/brightness
  const img = fctx.getImageData(0,0,W,H);
  const d = img.data;
  const c = 1.22;
  const b = 6;
  for (let i=0;i<d.length;i+=4){
    d[i]   = clamp((d[i]-128)*c + 128 + b, 0, 255);
    d[i+1] = clamp((d[i+1]-128)*c + 128 + b, 0, 255);
    d[i+2] = clamp((d[i+2]-128)*c + 128 + b, 0, 255);
  }
  fctx.putImageData(img,0,0);

  // blue haze overlay
  fctx.save();
  fctx.globalCompositeOperation = "screen";
  fctx.globalAlpha = 0.22;
  fctx.fillStyle = "rgb(40,120,255)";
  fctx.fillRect(0,0,W,H);
  fctx.restore();
}

// SNAP true crop
function snapPhoto(){
  const a = document.createElement('a');
  a.download = `blobtrack_v2_${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
  a.href = frame.toDataURL('image/png');
  a.click();
}

// REC true crop (webm)
function pickMimeType(){
  const opts = ["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm"];
  for (const t of opts) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}
function startRecording(){
  if (!('MediaRecorder' in window)){
    ui.tip.textContent = "MediaRecorder not supported here.";
    return;
  }
  try{
    const stream = frame.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    recChunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: recorder.mimeType || "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = `blobtrack_v2_${new Date().toISOString().replace(/[:.]/g,'-')}.webm`;
      a.href = url;
      a.click();
      setTimeout(()=>URL.revokeObjectURL(url), 2500);
    };
    recorder.start();
    isRecording = true;
    ui.rec.textContent = "STOP";
    ui.tip.textContent = "Recording…";
  }catch(err){
    ui.tip.textContent = `REC failed: ${String(err)}`;
  }
}
function stopRecording(){
  if (recorder && isRecording) recorder.stop();
  isRecording = false;
  ui.rec.textContent = "REC";
  ui.tip.textContent = "Saved.";
}

// Camera start (user-gesture triggered)
async function startCamera(){
  // Must be secure context
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol !== "https:" && !isLocal){
    throw new Error(`Not HTTPS: ${location.href}`);
  }
  if (!navigator.mediaDevices?.getUserMedia){
    throw new Error("navigator.mediaDevices.getUserMedia not available.");
  }

  if (stream) stream.getTracks().forEach(t => t.stop());

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });

  video.srcObject = stream;

  await new Promise((res, rej) => {
    video.onloadedmetadata = () => res();
    setTimeout(() => rej(new Error("Video metadata timeout")), 4000);
  });

  resizeAll();
  requestAnimationFrame(loop);
}

function loop(){
  // handle resize changes
  const key = [
    chosenMode(),
    ui.format.value,
    ui.s_res.value,
    (window.visualViewport?.width || 0),
    (window.visualViewport?.height || 0),
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

  // 2) blob tracking overlay
  const pts = computeBlobPoints();
  drawBlobsAndLines(pts);

  // 3) bloom + ps2 haze
  const bloomAmt = parseInt(ui.s_bloom.value,10)/100;
  if (ui.t_bloom.checked && bloomAmt > 0.01) applyBloom(bloomAmt);
  if (ui.t_ps2.checked) applyPS2Haze();

  // 4) display (letterboxed)
  drawFrameToScreen();

  requestAnimationFrame(loop);
}

/* UI events */
ui.hud.addEventListener('click', () => setHudHidden(!hudHidden));
showHudBtn.addEventListener('click', () => setHudHidden(false));

ui.snap.addEventListener('click', snapPhoto);
ui.rec.addEventListener('click', () => isRecording ? stopRecording() : startRecording());

ui.flip.addEventListener('click', async () => {
  facingMode = (facingMode === "environment") ? "user" : "environment";
  try{
    await startCamera();
  }catch(err){
    logErr(String(err));
  }
});

ui.format.addEventListener('change', () => { lastKey=""; resizeAll(); });
ui.s_res.addEventListener('input', () => { lastKey=""; resizeAll(); });

if (window.visualViewport){
  window.visualViewport.addEventListener('resize', () => { lastKey=""; resizeAll(); });
  window.visualViewport.addEventListener('scroll', () => { lastKey=""; resizeAll(); });
}
window.addEventListener('orientationchange', () => { lastKey=""; resizeAll(); });
window.addEventListener('resize', () => { lastKey=""; resizeAll(); });

/* START button: guaranteed permission prompt path */
startBtn.addEventListener('click', async () => {
  clearErr();
  ui.tip.textContent = "Starting camera…";
  try{
    await startCamera();
    overlay.style.display = "none";
    ui.tip.textContent = "Running.";
  }catch(err){
    logErr(String(err));
    ui.tip.textContent = "Failed. See error.";
  }
});

// Extra: if app.js didn't load, you'd never see this overlay respond.
// So show a tiny initial message:
ui.tip.textContent = "Tap START.";
