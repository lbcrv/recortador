// Recortador — todo el procesamiento ocurre en este dispositivo.
// Nada de la foto se envía a ningún servidor: solo se descarga (una vez) el modelo de IA.

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';
const MODEL = 'briaai/RMBG-1.4';
const MAX_SIDE = 4096;
const UNDO_MAX = 15;

const $ = (s) => document.querySelector(s);
const stage = $('#stage'), cv = $('#cv'), ctx = cv.getContext('2d', { willReadFrequently: false });
const cursorEl = $('#cursor');

const S = {
  W: 0, H: 0, name: 'imagen',
  src: null,      // RGBA original (Uint8ClampedArray)
  alpha: null,    // máscara actual (Uint8ClampedArray, W*H)
  bg: null,       // color de fondo estimado [r,g,b] para quitar halo, o null
  undo: [], redo: [],
  tab: 'flat',
  view: { s: 1, x: 0, y: 0 },
  flat: { seeds: [], tol: 20, feather: 14, choke: 1, contiguous: true },
  brush: { size: 40, erase: true, offset: true },
  dehalo: true,
  viewBg: 'chk', viewColor: '#f2c94c',
};

// ---------- utilidades UI ----------
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function busy(on, txt = 'Procesando…', pct = null, sub = '') {
  $('#busy').classList.toggle('show', on);
  $('#busyTxt').textContent = txt;
  $('#busySub').textContent = sub;
  $('#busyBar').parentElement.style.display = pct == null ? 'none' : '';
  if (pct != null) $('#busyBar').style.width = Math.round(pct) + '%';
}
// deja que el navegador pinte el aviso antes de un cálculo pesado (setTimeout también funciona en segundo plano)
const nextFrame = () => new Promise((r) => setTimeout(r, 40));

// ---------- carga de imagen ----------
async function loadFile(file) {
  if (!file) return;
  busy(true, 'Abriendo foto…');
  await nextFrame();
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
    cv.width = W; cv.height = H;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bmp, 0, 0, W, H);
    bmp.close?.();
    S.src = ctx.getImageData(0, 0, W, H).data;
    S.W = W; S.H = H;
    S.alpha = new Uint8ClampedArray(W * H);
    // pixeles ya transparentes en el original (PNG) se respetan
    for (let i = 0, n = W * H; i < n; i++) S.alpha[i] = S.src[i * 4 + 3];
    S.bg = null; S.undo = []; S.redo = []; S.flat.seeds = [];
    S.name = (file.name || 'imagen').replace(/\.[^.]+$/, '');
    $('#empty').classList.add('hidden'); cv.classList.remove('hidden'); $('#tools').classList.remove('hidden');
    fit(); compose(); updUndo();
    // ¿fondo liso? -> se resuelve al instante sin IA
    const auto = autoSeed();
    if (auto && auto.uniform) {
      S.flat.seeds = [auto.seed];
      setTab('flat');
      runFlat(false);
      toast('Fondo liso detectado ✔  Toca el fondo si falta algo');
    } else {
      setTab('ai');
      toast('Fondo con detalles: usa la IA');
    }
  } catch (e) {
    console.error(e); toast('No se pudo abrir la imagen');
  } finally { busy(false); }
}

// ---------- composición ----------
function compose(x0 = 0, y0 = 0, x1 = S.W, y1 = S.H) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(S.W, Math.ceil(x1)); y1 = Math.min(S.H, Math.ceil(y1));
  const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) return;
  const img = ctx.createImageData(w, h), d = img.data, src = S.src, A = S.alpha, W = S.W;
  const bg = S.dehalo ? S.bg : null;
  const br = bg ? bg[0] : 0, bgg = bg ? bg[1] : 0, bb = bg ? bg[2] : 0;
  for (let y = 0; y < h; y++) {
    let si = (y + y0) * W + x0, di = y * w * 4;
    for (let x = 0; x < w; x++, si++, di += 4) {
      const a = A[si]; if (!a) continue;
      const p = si * 4;
      let r = src[p], g = src[p + 1], b = src[p + 2];
      if (bg && a < 250) {
        // des-mezcla: I = a*F + (1-a)*B  ->  F = (I - (1-a)*B) / a
        const f = a / 255, inv = 1 - f, k = 1 / Math.max(f, 0.2);
        r = (r - inv * br) * k; g = (g - inv * bgg) * k; b = (b - inv * bb) * k;
      }
      d[di] = r; d[di + 1] = g; d[di + 2] = b; d[di + 3] = a;
    }
  }
  ctx.putImageData(img, x0, y0);
}

// ---------- deshacer ----------
function snapshot() {
  S.undo.push({ a: S.alpha.slice(), bg: S.bg, seeds: S.flat.seeds.slice() });
  if (S.undo.length > UNDO_MAX) S.undo.shift();
  S.redo = []; updUndo();
}
function restore(from, to) {
  const st = from.pop(); if (!st) return;
  to.push({ a: S.alpha, bg: S.bg, seeds: S.flat.seeds });
  S.alpha = st.a; S.bg = st.bg; S.flat.seeds = st.seeds;
  compose(); updUndo();
}
function updUndo() { $('#bUndo').disabled = !S.undo.length; $('#bRedo').disabled = !S.redo.length; }

// ---------- fondo liso ----------
// distancia de color "redmean" (aprox. perceptual), escala ~0..270
function cdist(r, g, b, B) {
  const rm = (r + B[0]) * 0.5, dr = r - B[0], dg = g - B[1], db = b - B[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
}
function sampleColor(x, y, rad = 2) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = Math.max(0, y - rad); yy <= Math.min(S.H - 1, y + rad); yy++)
    for (let xx = Math.max(0, x - rad); xx <= Math.min(S.W - 1, x + rad); xx++) {
      const p = (yy * S.W + xx) * 4; r += S.src[p]; g += S.src[p + 1]; b += S.src[p + 2]; n++;
    }
  return [r / n, g / n, b / n];
}
function borderIdx() {
  const { W, H } = S, out = [];
  const step = Math.max(1, Math.floor((W + H) / 800));
  for (let x = 0; x < W; x += step) out.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y += step) out.push(y * W, y * W + W - 1);
  return out;
}
function autoSeed() {
  const idx = borderIdx().filter((i) => S.alpha[i] > 0);
  if (idx.length < 8) return null;
  const ch = [[], [], []];
  for (const i of idx) { const p = i * 4; ch[0].push(S.src[p]); ch[1].push(S.src[p + 1]); ch[2].push(S.src[p + 2]); }
  const med = ch.map((a) => a.sort((u, v) => u - v)[a.length >> 1]);
  const pts = idx.filter((i) => { const p = i * 4; return cdist(S.src[p], S.src[p + 1], S.src[p + 2], med) < 14; });
  return { uniform: pts.length / idx.length > 0.8, seed: { c: med, pts } };
}
function runFlat(pushUndo = true) {
  if (!S.flat.seeds.length) {
    const a = autoSeed();
    if (!a || a.seed.pts.length < 4) { toast('Toca el fondo que quieres quitar'); return; }
    S.flat.seeds = [a.seed];
  }
  if (pushUndo) snapshot();
  const { W, H, src } = S, N = W * H;
  const A = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) A[i] = src[i * 4 + 3];
  const lo = S.flat.tol, hi = lo + Math.max(1, S.flat.feather), span = hi - lo;
  const MAXDEP = 3; // los bordes semitransparentes pueden propagarse solo unos pocos píxeles
  let seen = null, q = null, dep = null;
  for (const seed of S.flat.seeds) {
    const B = seed.c;
    if (!S.flat.contiguous) {
      for (let i = 0; i < N; i++) {
        const p = i * 4, d = cdist(src[p], src[p + 1], src[p + 2], B);
        if (d < hi) { const a = d <= lo ? 0 : (255 * (d - lo)) / span; if (a < A[i]) A[i] = a; }
      }
      continue;
    }
    if (!seen) { seen = new Uint8Array(N); q = new Int32Array(N); dep = new Uint8Array(N); } else { seen.fill(0); }
    let qh = 0, qt = 0;
    for (const s of seed.pts) if (!seen[s]) { seen[s] = 1; dep[s] = 0; q[qt++] = s; }
    while (qh < qt) {
      const i = q[qh++], p = i * 4;
      const d = cdist(src[p], src[p + 1], src[p + 2], B);
      if (d >= hi) continue;
      let nd;
      if (d <= lo) { if (A[i]) A[i] = 0; nd = 0; }
      else { const a = (255 * (d - lo)) / span; if (a < A[i]) A[i] = a; nd = dep[i] + 1; if (nd > MAXDEP) continue; }
      const x = i % W;
      if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; dep[i - 1] = nd; q[qt++] = i - 1; }
      if (x < W - 1 && !seen[i + 1]) { seen[i + 1] = 1; dep[i + 1] = nd; q[qt++] = i + 1; }
      if (i >= W && !seen[i - W]) { seen[i - W] = 1; dep[i - W] = nd; q[qt++] = i - W; }
      if (i < N - W && !seen[i + W]) { seen[i + W] = 1; dep[i + W] = nd; q[qt++] = i + W; }
    }
  }
  let out = A;
  for (let k = 0; k < S.flat.choke; k++) out = erode(out);
  S.alpha = out;
  S.bg = S.flat.seeds[0].c;
  compose();
}
function flatTap(ix, iy) {
  ix = Math.round(ix); iy = Math.round(iy);
  if (ix < 0 || iy < 0 || ix >= S.W || iy >= S.H) return;
  const c = sampleColor(ix, iy);
  snapshot();
  S.flat.seeds = [...S.flat.seeds, { c, pts: [iy * S.W + ix] }];
  runFlat(false);
}

// ---------- IA ----------
let AI = null, aiKey = '';
async function loadAI(q) {
  if (AI && aiKey === q) return AI;
  const T = await import(TRANSFORMERS);
  T.env.allowLocalModels = false;
  const files = {};
  const progress_callback = (e) => {
    if (e.status === 'progress' && e.total) {
      files[e.file] = [e.loaded, e.total];
      let l = 0, t = 0; for (const k in files) { l += files[k][0]; t += files[k][1]; }
      busy(true, 'Descargando modelo (solo la primera vez)…', (100 * l) / t, `${(l / 1e6).toFixed(1)} / ${(t / 1e6).toFixed(1)} MB`);
    }
  };
  const tryLoad = async (device, dtype) => T.AutoModel.from_pretrained(MODEL, { config: { model_type: 'custom' }, device, dtype, progress_callback });
  let model;
  const gpu = !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
  if (q === 'best') {
    try { model = gpu ? await tryLoad('webgpu', 'fp32') : await tryLoad('wasm', 'fp32'); }
    catch (e) { console.warn('fallback', e); model = await tryLoad('wasm', 'fp32'); }
  } else {
    model = await tryLoad('wasm', 'q8');
  }
  const processor = await T.AutoProcessor.from_pretrained(MODEL, {
    config: {
      do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
      image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1], feature_extractor_type: 'ImageFeatureExtractor',
      resample: 2, rescale_factor: 1 / 255, size: { width: 1024, height: 1024 },
    },
  });
  AI = { T, model, processor }; aiKey = q;
  return AI;
}
async function runAI() {
  const q = $('#aiQ').value;
  busy(true, 'Preparando IA…');
  await nextFrame();
  try {
    const { T, model, processor } = await loadAI(q);
    busy(true, 'Quitando fondo…');
    await nextFrame();
    // imagen original sin máscara, reducida (el modelo trabaja a 1024 px)
    const k = Math.min(1, 1024 / Math.max(S.W, S.H));
    const w = Math.round(S.W * k), h = Math.round(S.H * k);
    const full = new OffscreenCanvas(S.W, S.H);
    full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(S.src), S.W, S.H), 0, 0);
    const small = new OffscreenCanvas(w, h);
    small.getContext('2d').drawImage(full, 0, 0, w, h);
    const px = small.getContext('2d').getImageData(0, 0, w, h).data;
    const image = new T.RawImage(new Uint8ClampedArray(px), w, h, 4).rgb();
    const { pixel_values } = await processor(image);
    const { output } = await model({ input: pixel_values });
    const mask = await T.RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(S.W, S.H);
    snapshot();
    const A = new Uint8ClampedArray(S.W * S.H), m = mask.data, src = S.src;
    for (let i = 0; i < A.length; i++) {
      let a = m[i]; if (a < 6) a = 0; else if (a > 249) a = 255;
      A[i] = Math.min(a, src[i * 4 + 3]);
    }
    S.alpha = A;
    S.bg = estimateBg();
    compose();
    toast('Listo. Usa el pincel para retocar.');
  } catch (e) {
    console.error(e);
    toast('Error con la IA: ' + (e.message || e), 5000);
  } finally { busy(false); }
}
// color de fondo promedio (si es parejo) para quitar halo tras la IA
function estimateBg() {
  const { W, H, src, alpha } = S; const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 40000)));
  let n = 0, s = [0, 0, 0], s2 = [0, 0, 0];
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    const i = y * W + x; if (alpha[i] !== 0 || src[i * 4 + 3] < 255) continue;
    for (let c = 0; c < 3; c++) { const v = src[i * 4 + c]; s[c] += v; s2[c] += v * v; } n++;
  }
  if (n < 50) return null;
  const mean = s.map((v) => v / n);
  const sd = s2.map((v, c) => Math.sqrt(Math.max(0, v / n - mean[c] * mean[c])));
  return (sd[0] + sd[1] + sd[2]) / 3 < 22 ? mean : null;
}

// ---------- pincel ----------
function paintDot(ix, iy) {
  const r = S.brush.size / 2 / S.view.s, inner = r * 0.55;
  const x0 = Math.max(0, Math.floor(ix - r)), x1 = Math.min(S.W - 1, Math.ceil(ix + r));
  const y0 = Math.max(0, Math.floor(iy - r)), y1 = Math.min(S.H - 1, Math.ceil(iy + r));
  const A = S.alpha, src = S.src, er = S.brush.erase;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x - ix, y - iy); if (d > r) continue;
    const t = d <= inner ? 1 : 1 - (d - inner) / (r - inner); // fuerza 0..1
    const i = y * S.W + x;
    if (er) { const v = 255 * (1 - t); if (v < A[i]) A[i] = v; }
    else { const v = Math.min(255 * t, src[i * 4 + 3]); if (v > A[i]) A[i] = v; }
  }
  return [x0, y0, x1 + 1, y1 + 1];
}
let lastPaint = null;
function paintTo(ix, iy) {
  const r = S.brush.size / 2 / S.view.s, step = Math.max(0.7, r * 0.3);
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (b) => { box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]; };
  if (!lastPaint) grow(paintDot(ix, iy));
  else {
    const dx = ix - lastPaint[0], dy = iy - lastPaint[1], n = Math.ceil(Math.hypot(dx, dy) / step);
    for (let k = 1; k <= n; k++) grow(paintDot(lastPaint[0] + (dx * k) / n, lastPaint[1] + (dy * k) / n));
  }
  lastPaint = [ix, iy];
  if (box[0] < Infinity) compose(...box);
}
function erode(A) {
  const { W, H } = S, B = A.slice();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let m = A[i]; if (!m) continue;
    if (x > 0 && A[i - 1] < m) m = A[i - 1];
    if (x < W - 1 && A[i + 1] < m) m = A[i + 1];
    if (y > 0 && A[i - W] < m) m = A[i - W];
    if (y < H - 1 && A[i + W] < m) m = A[i + W];
    B[i] = m;
  }
  return B;
}
function choke() { snapshot(); S.alpha = erode(S.alpha); compose(); }

// ---------- vista / gestos ----------
function applyView() {
  const { s, x, y } = S.view;
  cv.style.transform = `translate(${x}px,${y}px) scale(${s})`;
  cv.style.imageRendering = s > 2.5 ? 'pixelated' : 'auto';
}
function fit() {
  if (!S.W) return;
  const r = stage.getBoundingClientRect();
  const s = Math.min(r.width / S.W, r.height / S.H) * 0.94;
  S.view = { s, x: (r.width - S.W * s) / 2, y: (r.height - S.H * s) / 2 };
  applyView();
}
function toImg(cx, cy) {
  const r = stage.getBoundingClientRect();
  return [(cx - r.left - S.view.x) / S.view.s, (cy - r.top - S.view.y) / S.view.s];
}
function zoomAt(cx, cy, factor) {
  const r = stage.getBoundingClientRect(), px = cx - r.left, py = cy - r.top;
  const s = Math.min(40, Math.max(0.05, S.view.s * factor)), f = s / S.view.s;
  S.view = { s, x: px - (px - S.view.x) * f, y: py - (py - S.view.y) * f };
  applyView();
}
const OFFSET_PX = 70;
function brushPoint(e) { return [e.clientX, e.clientY - (S.brush.offset && e.pointerType === 'touch' ? OFFSET_PX : 0)]; }
function showCursor(cx, cy) {
  if (S.tab !== 'brush') { cursorEl.style.display = 'none'; return; }
  const r = stage.getBoundingClientRect();
  cursorEl.style.display = 'block';
  cursorEl.style.left = cx - r.left + 'px'; cursorEl.style.top = cy - r.top + 'px';
  cursorEl.style.width = cursorEl.style.height = S.brush.size + 'px';
}

const ptrs = new Map(); let G = null;
stage.addEventListener('pointerdown', (e) => {
  if (!S.W || e.target.closest('#busy')) return;
  stage.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) {
    if (G && G.type === 'paint' && G.painted) restore(S.undo, []); // cancela el trazo
    const [a, b] = [...ptrs.values()];
    G = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), m0: [(a.x + b.x) / 2, (a.y + b.y) / 2], v0: { ...S.view } };
    cursorEl.style.display = 'none';
  } else if (ptrs.size === 1) {
    const paint = S.tab === 'brush' && (e.pointerType !== 'mouse' || e.button === 0);
    G = { type: paint ? 'paint' : 'pan', sx: e.clientX, sy: e.clientY, moved: false, v0: { ...S.view }, painted: false };
    if (paint) {
      snapshot(); G.painted = true; lastPaint = null;
      const [cx, cy] = brushPoint(e); showCursor(cx, cy); paintTo(...toImg(cx, cy));
    }
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) {
    if (e.pointerType === 'mouse' && S.tab === 'brush' && S.W) showCursor(e.clientX, e.clientY);
    return;
  }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!G) return;
  if (G.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), m = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    const s = Math.min(40, Math.max(0.05, G.v0.s * (d / Math.max(1, G.d0))));
    const r = stage.getBoundingClientRect();
    const ix = (G.m0[0] - r.left - G.v0.x) / G.v0.s, iy = (G.m0[1] - r.top - G.v0.y) / G.v0.s;
    S.view = { s, x: m[0] - r.left - ix * s, y: m[1] - r.top - iy * s };
    applyView();
  } else if (G.type === 'paint') {
    const [cx, cy] = brushPoint(e); showCursor(cx, cy); paintTo(...toImg(cx, cy));
  } else if (G.type === 'pan') {
    const dx = e.clientX - G.sx, dy = e.clientY - G.sy;
    if (!G.moved && Math.hypot(dx, dy) > 8) G.moved = true;
    if (G.moved) { S.view = { ...G.v0, x: G.v0.x + dx, y: G.v0.y + dy }; applyView(); }
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (G && G.type === 'pan' && !G.moved && ptrs.size === 0 && S.tab === 'flat') flatTap(...toImg(e.clientX, e.clientY));
  if (ptrs.size === 0) { G = null; lastPaint = null; if (e.pointerType !== 'mouse') cursorEl.style.display = 'none'; }
  else if (G && G.type === 'pinch') G = { type: 'pan', sx: [...ptrs.values()][0].x, sy: [...ptrs.values()][0].y, moved: true, v0: { ...S.view } };
}
stage.addEventListener('pointerup', endPtr);
stage.addEventListener('pointercancel', endPtr);
stage.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') cursorEl.style.display = 'none'; });
stage.addEventListener('wheel', (e) => { if (!S.W) return; e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
window.addEventListener('resize', () => S.W && fit());

// ---------- pestañas y controles ----------
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'p-' + t));
  cursorEl.style.display = 'none';
  requestAnimationFrame(() => S.W && applyView());
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.t)));

const openPicker = () => $('#file').click();
$('#bOpen').onclick = openPicker; $('#bOpen2').onclick = openPicker;
$('#file').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };
$('#bUndo').onclick = () => restore(S.undo, S.redo);
$('#bRedo').onclick = () => restore(S.redo, S.undo);
$('#bFit').onclick = fit;

let flatTimer;
const flatLive = () => { clearTimeout(flatTimer); flatTimer = setTimeout(() => { if (S.flat.seeds.length) runFlat(false); }, 60); };
let sliderUndo = false;
for (const [id, key, out] of [['#fTol', 'tol', '#oTol'], ['#fFea', 'feather', '#oFea'], ['#fChk', 'choke', '#oChk']]) {
  const el = $(id);
  el.addEventListener('pointerdown', () => { sliderUndo = true; });
  el.addEventListener('input', () => {
    if (sliderUndo && S.flat.seeds.length) { snapshot(); sliderUndo = false; }
    S.flat[key] = +el.value; $(out).textContent = el.value; flatLive();
  });
}
$('#fCont').onchange = (e) => { S.flat.contiguous = e.target.checked; if (S.flat.seeds.length) runFlat(); };
$('#fReset').onclick = () => { S.flat.seeds = []; runFlat(); };

$('#aiRun').onclick = runAI;

$('#brErase').onclick = () => { S.brush.erase = true; $('#brErase').classList.add('on'); $('#brRestore').classList.remove('on'); };
$('#brRestore').onclick = () => { S.brush.erase = false; $('#brRestore').classList.add('on'); $('#brErase').classList.remove('on'); };
$('#brSize').oninput = (e) => { S.brush.size = +e.target.value; $('#oSize').textContent = e.target.value; };
$('#brOff').onchange = (e) => { S.brush.offset = e.target.checked; };
$('#brChoke').onclick = choke;

function setViewBg(v) {
  S.viewBg = v;
  cv.classList.remove('white', 'black', 'custom');
  cv.style.backgroundColor = '';
  if (v === 'white' || v === 'black') cv.classList.add(v);
  if (v === 'custom') { cv.classList.add('custom'); cv.style.backgroundColor = S.viewColor; }
  document.querySelectorAll('#views .sw').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}
document.querySelectorAll('#views .sw').forEach((b) => (b.onclick = () => setViewBg(b.dataset.v)));
$('#vColor').oninput = (e) => { S.viewColor = e.target.value; setViewBg('custom'); };
$('#sHalo').onchange = (e) => { S.dehalo = e.target.checked; compose(); };

// ---------- exportar ----------
function exportBlob() {
  let x0 = 0, y0 = 0, x1 = S.W, y1 = S.H, pad = 0;
  if ($('#sCrop').checked) {
    x0 = S.W; y0 = S.H; x1 = 0; y1 = 0;
    const A = S.alpha;
    for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) if (A[y * S.W + x] > 8) {
      if (x < x0) x0 = x; if (x >= x1) x1 = x + 1; if (y < y0) y0 = y; if (y >= y1) y1 = y + 1;
    }
    if (x1 <= x0) { toast('No queda nada que guardar'); return null; }
    pad = Math.max(0, +$('#sPad').value || 0);
  }
  const c = document.createElement('canvas');
  c.width = x1 - x0 + 2 * pad; c.height = y1 - y0 + 2 * pad;
  const g = c.getContext('2d');
  const fill = S.viewBg === 'white' ? '#fff' : S.viewBg === 'black' ? '#000' : S.viewBg === 'custom' ? S.viewColor : null;
  if (fill) { g.fillStyle = fill; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(cv, x0, y0, x1 - x0, y1 - y0, pad, pad, x1 - x0, y1 - y0);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}
$('#sSave').onclick = async () => {
  const blob = await exportBlob(); if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${S.name}-sin-fondo.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Guardado en Descargas');
};
$('#sShare').onclick = async () => {
  const blob = await exportBlob(); if (!blob) return;
  const file = new File([blob], `${S.name}-sin-fondo.png`, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { /* cancelado */ }
  } else toast('Este navegador no permite compartir; usa Guardar');
};

// ---------- compartir hacia la app (Android) y modo offline ----------
async function checkShared() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('shared');
    const res = await cache.match('shared-image');
    if (res) {
      const blob = await res.blob(); await cache.delete('shared-image');
      loadFile(new File([blob], res.headers.get('x-name') || 'compartida', { type: blob.type }));
    }
  } catch (e) { console.warn(e); }
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
setTab('flat');
checkShared();

// para pruebas desde la consola
window.__recortador = { S, loadFile, runFlat, runAI };
