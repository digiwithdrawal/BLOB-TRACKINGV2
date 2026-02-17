/* BlobTrack Cam V2 — TouchDesigner-like HUD
   - points from motion-diff
   - draw TD overlay: squares + coord text + connecting lines
   - "ATMOS" controls spread/jitter + line connect radius
   - "FX" controls contrast + blue haze + bloom together
   - optional MATRIX number glitch overlay
   - Gate: OFF / FACE (FaceDetector) / PERSON (motion presence)
   - TRUE output frame with ratio modes (auto/portrait/landscape/square)
*/

const $ = (id) => document.getElementById(id);

const overlay = $("startOverlay");
const startBtn = $("startBtn");
const errBox = $("errBox");
const tip = $("tip");

function logErr(msg){
  errBox.textContent = (errBox.textContent ? errBox.textContent + "\n\n" : "") + msg;
}
function clearErr(){ errBox.textContent = ""; }

const video = $("vid");
const screen = $("screen");
const sctx = screen.getContext("2d", { willReadFrequently: true });

// true output
const frame = document.createElement("canvas");
const fctx = frame.getContext("2d", { willReadFrequently: true });

// analysis buffer
const ana = document.createElement("canvas");
const actx = ana.getContext("2d", { willReadFrequently: true });
let prevAna = null;

const ui = {
  flip: $("flip"),
  snap: $("snap"),
  rec: $("rec"),
  hud: $("hud"),
  showHud: $("showHud"),
  panel: $("panel"),

  format: $("format"),
  ink: $("ink"),
  gate: $("gate"),

  t_matrix: $("t_matrix"),

  s_amount: $("s_amount"),
  s_atmo: $("s_atmo"),
  s_fx: $("s_fx"),
  s_res: $("s_res"),
};

let facingMode = "environment";
let stream = null;
let lastKey = "";

let hudHidden = false;
function setHudHidden(v){
  hudHidden = !!v;
  ui.panel.classList.toggle("hidden", hudHidden);
  ui.showHud.classList.toggle("show", hudHidden);
  ui.hud.textContent = hudHidden ? "SHOW HUD" : "HIDE HUD";
}
setHudHidden(false);

// recording
let recorder = null;
let recChunks = [];
let isRecording = false;

function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function lerp(a,b,t){ return a + (b-a)*t; }
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
  // portrait-ish clamp based on viewport
  const { vw, vh } = viewportSize();
  return clamp(vw / vh, 9/19.5, 9/14);
}

function resizeAll(){
  const { vw, vh } = viewportSize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  screen.width = Math.floor(vw * dpr);
  screen.height = Math.floor(vh * dpr);

  const res = parseInt(ui.s_res.value, 10); // short side
  const mode = chosenMode();
  const ar = modeAspect(mode);

  let fw, fh;
  if (ar >= 1){ fh = res; fw = Math.round(res * ar); }
  else { fw = res; fh = Math.round(res / ar); }

  frame.width = fw;
  frame.height = fh;

  // analysis buffer fixed
  ana.width = 220;
  ana.height = Math.max(110, Math.round(220 * (fh / fw)));
  prevAna = null;

  tip.innerHTML = `Mode: <b>${mode.toUpperCase()}</b> • Output: <b>${fw}×${fh}</b>`;
}

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

function drawFrameToScreen(){
  const SW = screen.width, SH = screen.height;
  const FW = frame.width, FH = frame.height;

  const scale = Math.min(SW/FW, SH/FH);
  const dw = Math.round(FW*scale);
  const dh = Math.round(FH*scale);
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

function inkStyle(){
  switch(ui.ink.value){
    case "neon": return { stroke:"rgba(80,255,140,.95)", fill:"rgba(80,255,140,.95)" };
    case "ice":  return { stroke:"rgba(160,220,255,.95)", fill:"rgba(160,220,255,.95)" };
    case "red":  return { stroke:"rgba(255,80,80,.95)", fill:"rgba(255,80,80,.95)" };
    case "white":
    default:     return { stroke:"rgba(255,255,255,.95)", fill:"rgba(255,255,255,.95)" };
  }
}

/* ---------- GATE: OFF / FACE / PERSON ---------- */
let faceDetector = null;
try{
  if ("FaceDetector" in window) faceDetector = new FaceDetector({ fastMode:true, maxDetectedFaces:1 });
}catch(_){ faceDetector = null; }

let gateOK = true;
let gateHold = 0; // frames
let gateTick = 0;

async function updateGate(){
  const mode = ui.gate.value;

  if (mode === "off"){
    gateOK = true;
    gateHold = 0;
    return;
  }

  // hold if recently detected
  if (gateHold > 0){
    gateHold--;
    gateOK = true;
    return;
  }

  if (mode === "face"){
    if (!faceDetector){
      gateOK = true; // fail open
      return;
    }
    try{
      const faces = await faceDetector.detect(frame);
      if (faces && faces.length){
        gateOK = true;
        gateHold = 12;
      } else {
        gateOK = false;
      }
    }catch(_){
      gateOK = true;
    }
    return;
  }

  // "person" gate: motion presence heuristic (if lots of motion pixels)
  // (Not true ML person detection — but feels like “only when something is there”.)
  if (mode === "person"){
    const score = lastMotionScore; // updated in computePoints()
    gateOK = score > 0.018; // tuned threshold
    if (gateOK) gateHold = 10;
    return;
  }
}

/* ---------- POINTS from motion diff ---------- */
let lastMotionScore = 0;

function computePoints(){
  actx.imageSmoothingEnabled = true;
  actx.drawImage(frame, 0, 0, ana.width, ana.height);
  const cur = actx.getImageData(0,0,ana.width, ana.height);
  const d = cur.data;

  if (!prevAna){
    prevAna = cur;
    lastMotionScore = 0;
    return [];
  }
  const pd = prevAna.data;

  const amount = parseInt(ui.s_amount.value,10);
  const atmo = parseInt(ui.s_atmo.value,10)/100;

  // sensitivity based on atmo a bit (more atmo -> more “alive”)
  const thr = 18 - atmo*6; // lower threshold = more hits

  const step = 2;
  const hits = [];
  let motionHits = 0;
  const totalSamples = Math.floor((ana.width/step) * (ana.height/step));

  for (let y=0; y<ana.height; y+=step){
    for (let x=0; x<ana.width; x+=step){
      const i = (y*ana.width + x)*4;

      const lum  = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
      const plum = 0.2126*pd[i] + 0.7152*pd[i+1] + 0.0722*pd[i+2];

      const diff = Math.abs(lum - plum);
      if (diff > thr){
        motionHits++;
        hits.push({ x, y, w: diff });
      }
    }
  }

  prevAna = cur;
  lastMotionScore = totalSamples ? (motionHits / totalSamples) : 0;

  if (!hits.length) return [];

  hits.sort((a,b)=> b.w - a.w);

  // spacing (TouchDesigner-ish scattered)
  const chosen = [];
  const maxN = Math.min(amount, 260);
  const minDist = lerp(5, 2.6, atmo); // more atmo = tighter possible clusters

  for (let i=0; i<hits.length && chosen.length<maxN; i++){
    const p = hits[i];
    let ok = true;
    for (const q of chosen){
      const dx=p.x-q.x, dy=p.y-q.y;
      if (dx*dx + dy*dy < minDist*minDist){ ok=false; break; }
    }
    if (ok) chosen.push(p);
  }

  // map + add atmosphere jitter scatter
  const sx = frame.width / ana.width;
  const sy = frame.height / ana.height;

  const jitter = lerp(0.5, 7.0, atmo);

  return chosen.map(p => ({
    x: p.x*sx + (rand(2)-1)*jitter,
    y: p.y*sy + (rand(2)-1)*jitter,
    w: p.w
  }));
}

/* ---------- TouchDesigner overlay draw ---------- */
function drawTDOverlay(points){
  const { stroke, fill } = inkStyle();
  const atmo = parseInt(ui.s_atmo.value,10)/100;

  // connect radius scales with atmosphere
  const link = lerp(90, 260, atmo);
  const link2 = link*link;

  fctx.save();
  fctx.lineCap = "butt";
  fctx.lineJoin = "miter";

  // TD-ish thin lines + crisp text
  fctx.strokeStyle = stroke;
  fctx.fillStyle = fill;

  // subtle glow
  fctx.shadowColor = stroke.replace(".95",".45");
  fctx.shadowBlur = 8;

  // font: robotic readable
  const fontPx = Math.max(10, Math.round(Math.min(frame.width, frame.height) * 0.018));
  fctx.font = `700 ${fontPx}px ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace`;
  fctx.textBaseline = "top";

  // lines (nearest-ish within link)
  fctx.globalAlpha = 0.70;
  for (let i=0; i<points.length; i++){
    const a = points[i];
    for (let j=i+1; j<points.length; j++){
      const b = points[j];
      const dx=a.x-b.x, dy=a.y-b.y;
      const d2=dx*dx+dy*dy;
      if (d2 < link2){
        const t = 1 - d2/link2;
        fctx.globalAlpha = 0.10 + t*0.55;
        fctx.lineWidth = 1;
        fctx.beginPath();
        fctx.moveTo(a.x,a.y);
        fctx.lineTo(b.x,b.y);
        fctx.stroke();
      }
    }
  }

  // squares + numeric coords
  fctx.globalAlpha = 0.92;
  for (let i=0; i<points.length; i++){
    const p = points[i];
    const size = 10 + clamp(p.w/6, 0, 22);

    // square
    fctx.lineWidth = 1;
    fctx.strokeRect(p.x - size/2, p.y - size/2, size, size);

    // numbers (TouchDesigner vibes)
    const tx = clamp(p.x + size/2 + 6, 6, frame.width - 120);
    const ty = clamp(p.y - size/2 - 2, 6, frame.height - 30);

    // show in frame-space coords (like examples)
    const label = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}`;
    fctx.fillText(label, tx, ty);
  }

  fctx.restore();
}

/* ---------- Matrix overlay ---------- */
const matrix = {
  cols: 0,
  drops: [],
  canvas: document.createElement("canvas"),
  ctx: null,
};
matrix.ctx = matrix.canvas.getContext("2d", { willReadFrequently: false });

function resizeMatrix(){
  matrix.canvas.width = frame.width;
  matrix.canvas.height = frame.height;

  const colW = 14; // fixed terminal vibe
  matrix.cols = Math.max(12, Math.floor(frame.width / colW));
  matrix.drops = new Array(matrix.cols).fill(0).map(()=> rand(frame.height));
}

function matrixStep(){
  const W = matrix.canvas.width, H = matrix.canvas.height;
  const ctx = matrix.ctx;
  ctx.save();

  // fade old trails
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  ctx.fillRect(0,0,W,H);

  const { fill } = inkStyle();

  // use overlay color but low alpha
  ctx.fillStyle = fill.replace(".95", ".35");
  ctx.font = `700 12px ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace`;

  const colW = Math.floor(W / matrix.cols);

  for (let i=0; i<matrix.cols; i++){
    let y = matrix.drops[i];

    // random “glitch” char set
    const chars = "0123456789ABCDEF#@$%";
    const c = chars[Math.floor(rand(chars.length))];

    const x = i * colW + Math.floor(rand(3));

    // occasional jump/glitch
    if (Math.random() < 0.03) y += rand(90);
    y += 14 + rand(10);

    ctx.fillText(c, x, y);

    // reset
    if (y > H + 20 || Math.random() < 0.01) y = -rand(200);

    matrix.drops[i] = y;
  }

  ctx.restore();
}

function drawMatrixToFrame(){
  // add as overlay
  fctx.save();
  fctx.globalCompositeOperation = "screen";
  fctx.globalAlpha = 0.65;
  fctx.drawImage(matrix.canvas, 0, 0);
  fctx.restore();
}

/* ---------- FX: contrast + blue haze + bloom (single strength slider) ---------- */
function applyFX(strength01){
  if (strength01 <= 0.001) return;

  const W = frame.width, H = frame.height;
  const img = fctx.getImageData(0,0,W,H);
  const d = img.data;

  // contrast / brightness from strength
  const c = lerp(1.0, 1.28, strength01);
  const b = lerp(0, 9, strength01);

  for (let i=0;i<d.length;i+=4){
    d[i]   = clamp((d[i]-128)*c + 128 + b, 0, 255);
    d[i+1] = clamp((d[i+1]-128)*c + 128 + b, 0, 255);
    d[i+2] = clamp((d[i+2]-128)*c + 128 + b, 0, 255);
  }
  fctx.putImageData(img,0,0);

  // blue haze veil (screen)
  fctx.save();
  fctx.globalCompositeOperation = "screen";
  fctx.globalAlpha = lerp(0.0, 0.22, strength01);
  fctx.fillStyle = "rgb(40,120,255)";
  fctx.fillRect(0,0,W,H);
  fctx.restore();

  // bloom (blurred self-copy)
  const blurPx = 6 + strength01 * 18;
  fctx.save();
  fctx.globalCompositeOperation = "screen";
  fctx.globalAlpha = lerp(0.0, 0.55, strength01);
  fctx.filter = `blur(${blurPx}px)`;
  fctx.drawImage(frame, 0, 0);
  fctx.filter = "none";
  fctx.restore();
}

/* ---------- SNAP + REC ---------- */
function snapPhoto(){
  const a = document.createElement("a");
  a.download = `blobtrack_v2_${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
  a.href = frame.toDataURL("image/png");
  a.click();
}

function pickMimeType(){
  const opts = ["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm"];
  for (const t of opts) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

function startRecording(){
  if (!("MediaRecorder" in window)){
    tip.textContent = "MediaRecorder not supported here.";
    return;
  }
  try{
    const stream = frame.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    recChunks = [];
    recorder.ondataavailable = (e)=> { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = ()=>{
      const blob = new Blob(recChunks, { type: recorder.mimeType || "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.download = `blobtrack_v2_${new Date().toISOString().replace(/[:.]/g,'-')}.webm`;
      a.href = url;
      a.click();
      setTimeout(()=>URL.revokeObjectURL(url), 2500);
    };
    recorder.start();
    isRecording = true;
    ui.rec.textContent = "STOP";
    tip.textContent = "Recording…";
  }catch(err){
    tip.textContent = `REC failed: ${String(err)}`;
  }
}

function stopRecording(){
  if (recorder && isRecording) recorder.stop();
  isRecording = false;
  ui.rec.textContent = "REC";
  tip.textContent = "Saved.";
}

/* ---------- CAMERA ---------- */
async function startCamera(){
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol !== "https:" && !isLocal){
    throw new Error("Camera requires https:// on iPhone Safari.");
  }
  if (!navigator.mediaDevices?.getUserMedia){
    throw new Error("getUserMedia not available.");
  }

  if (stream) stream.getTracks().forEach(t => t.stop());

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width:{ideal:1280}, height:{ideal:720} },
    audio: false
  });

  video.srcObject = stream;

  await new Promise((res, rej)=>{
    video.onloadedmetadata = ()=>res();
    setTimeout(()=>rej(new Error("Video metadata timeout")), 4500);
  });

  resizeAll();
  resizeMatrix();
  requestAnimationFrame(loop);
}

async function loop(){
  // keep in sync with viewport/orientation/format/res
  const key = [
    chosenMode(),
    ui.format.value,
    ui.s_res.value,
    (window.visualViewport?.width||0),
    (window.visualViewport?.height||0),
    video.videoWidth, video.videoHeight
  ].join("|");

  if (key !== lastKey){
    lastKey = key;
    resizeAll();
    resizeMatrix();
  }

  // camera -> frame
  fctx.setTransform(1,0,0,1,0,0);
  fctx.imageSmoothingEnabled = true;
  drawVideoCoverTo(fctx, frame.width, frame.height);

  // gate update (not every frame)
  gateTick++;
  if (gateTick % 8 === 0) await updateGate();

  // points + overlay
  if (gateOK){
    const pts = computePoints();
    drawTDOverlay(pts);
  } else {
    // still update motion so PERSON gate can recover
    computePoints();
  }

  // matrix
  if (ui.t_matrix.checked){
    matrixStep();
    drawMatrixToFrame();
  }

  // FX strength slider (contrast + haze + bloom)
  const fx = parseInt(ui.s_fx.value,10)/100;
  applyFX(fx);

  // display
  drawFrameToScreen();

  requestAnimationFrame(loop);
}

/* ---------- UI wiring ---------- */
ui.hud.addEventListener("click", ()=> setHudHidden(!hudHidden));
ui.showHud.addEventListener("click", ()=> setHudHidden(false));

ui.snap.addEventListener("click", snapPhoto);
ui.rec.addEventListener("click", ()=> isRecording ? stopRecording() : startRecording());

ui.flip.addEventListener("click", async ()=>{
  facingMode = (facingMode === "environment") ? "user" : "environment";
  try{
    await startCamera();
  }catch(err){ logErr(String(err)); }
});

ui.format.addEventListener("change", ()=> { lastKey=""; resizeAll(); resizeMatrix(); });
ui.s_res.addEventListener("input", ()=> { lastKey=""; resizeAll(); resizeMatrix(); });

if (window.visualViewport){
  window.visualViewport.addEventListener("resize", ()=> { lastKey=""; resizeAll(); resizeMatrix(); });
  window.visualViewport.addEventListener("scroll", ()=> { lastKey=""; resizeAll(); resizeMatrix(); });
}
window.addEventListener("orientationchange", ()=> { lastKey=""; resizeAll(); resizeMatrix(); });
window.addEventListener("resize", ()=> { lastKey=""; resizeAll(); resizeMatrix(); });

// START (permission)
startBtn.addEventListener("click", async ()=>{
  clearErr();
  tip.textContent = "Starting camera…";
  try{
    await startCamera();
    overlay.style.display = "none";
    tip.textContent = "Running.";
  }catch(err){
    logErr(String(err));
    tip.textContent = "Failed. See error.";
  }
});
