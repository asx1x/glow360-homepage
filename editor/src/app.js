(function () {
'use strict';
var G = G360;
var $ = function (id) { return document.getElementById(id); };
var LIMITS = { scenes: G.PRICING.maxScenes, bytes: 200 * 1024 * 1024 };

var state = { scenes: [], cur: -1, pending: null, portrait: false, aspect: true, auto: true, busy: false, nextId: 0, sel: null, cover: null, details: { clientName: '', clientEmail: '', address: '', url: '', unlisted: false, rightsConfirmed: false } }; // PIECE4 TWEAKS1
var viewer = null, autorotate = null;

/* ---------- helpers ---------- */
function toast(msg) { var t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(function () { t.style.display = 'none'; }, 2600); }
function clean(s, n) { return String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n); }
function fmtMB(b) { return (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB'; }
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
function toBlob(c, type, q) { return new Promise(function (res, rej) { c.toBlob(function (b) { b ? res(b) : rej(new Error('Encoding failed')); }, type, q); }); }
function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function r4(n) { return Math.round(n * 10000) / 10000; }
function curScene() { return state.scenes[state.cur] || null; }

/* ---------- viewer ---------- */
function ensureViewer() {
  if (viewer) return true;
  try {
    viewer = new Marzipano.Viewer($('pano'), { controls: { mouseViewMode: 'drag', scrollZoom: false } });
    try { viewer.controls().disableMethod('pinch'); } catch (e) {}   // no zoom: no scroll-wheel, no pinch
    autorotate = Marzipano.autorotate({ yawSpeed: 0.03, targetPitch: 0, targetFov: null });
    syncAutorotate();
    return true;
  } catch (e) {
    showErr('This browser could not start WebGL, which the 360° viewer needs.');
    return false;
  }
}

function syncAutorotate() {
  if (!viewer) return;
  if (state.auto && !state.sel) { viewer.startMovement(autorotate); viewer.setIdleMovement(3000, autorotate); }
  else { viewer.stopMovement(); viewer.setIdleMovement(Infinity); }
}
function updateTitle() {
  var s = curScene();
  var tn = $('tt-name'), a = clean(state.details.address, 120); tn.textContent = a || 'Your property address'; tn.className = a ? '' : 'dim';
  $('tt-scene-t').textContent = s ? s.name : ''; $('tt-scene').style.display = s ? '' : 'none';
}

function LocalSource(scene) { this.s = scene; }
LocalSource.prototype.loadAsset = function (stage, tile, done) {
  // NOTE: tiles are handed to WebGL as <canvas> elements, not ImageBitmaps. Marzipano sets
  // UNPACK_FLIP_Y, which WebGL ignores for ImageBitmap sources (tiles would render upside-down).
  var s = this.s, cancelled = false, p;
  if (tile.z === 0) p = Promise.resolve(s.fallback[tile.face]);
  else {
    var blob = s.tiles.get(G.tileKey(s.id, tile.z, tile.face, tile.y, tile.x));
    p = blob ? createImageBitmap(blob).then(function (bmp) {
      var c = mkCanvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
      try { bmp.close(); } catch (e) {} return c;
    }) : Promise.reject(new Error('missing tile'));
  }
  p.then(function (el) {
    if (cancelled) return;
    var asset = new Marzipano.StaticAsset(el);
    if (tile.z !== 0) { var d = asset.destroy; asset.destroy = function () { try { el.width = 0; } catch (e) {} d.apply(this, arguments); }; }
    done(null, tile, asset);
  }).catch(function (e) { if (!cancelled) done(e); });
  return function cancel() { cancelled = true; done.apply(null, arguments); };
};

function stageSize() { var p = $('pano'); return { w: p.clientWidth || 1, h: p.clientHeight || 1 }; }
var MAX_VFOV = 100 * Math.PI / 180, MAX_HFOV = 120 * Math.PI / 180;
// Zoom is locked at the widest ("fully zoomed out") view: at most 100° vertical and 120° horizontal.
// Wide screens are held by the horizontal limit, tall (portrait) screens by the vertical one.
// Marzipano's fov is the vertical field of view.
function fixedFov() {
  var z = stageSize();
  return Math.min(MAX_VFOV, 2 * Math.atan(Math.tan(MAX_HFOV / 2) * z.h / z.w));
}
function fixedFovLimiter() {
  return function (p) {
    p.fov = fixedFov();
    p.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p.pitch));
    return p;
  };
}
function startParams(s) { return { yaw: s.start.yaw, pitch: s.start.pitch, fov: fixedFov() }; }

function buildMz(s) {
  var geometry = new Marzipano.CubeGeometry(s.levels);
  var view = new Marzipano.RectilinearView(startParams(s), fixedFovLimiter());
  var scene = viewer.createScene({ source: new LocalSource(s), geometry: geometry, view: view, pinFirstLevel: true });
  s.mz = { scene: scene, view: view, hs: [] };
  renderHotspots(s);
}

function showScene(i, instant) {
  var s = state.scenes[i]; if (!s || !s.mz) return;
  if (state.sel) clearSel();
  state.cur = i;
  s.mz.view.setParameters(startParams(s));
  s.mz.scene.switchTo({ transitionDuration: instant ? 0 : 500 });
  $('empty').style.display = 'none';
  renderScenes(); syncPublish(); updateTitle(); syncAutorotate();
}

/* ---------- hotspots ---------- */
function findScene(id) { return state.scenes.filter(function (x) { return x.id === id; })[0]; }
function hsRec(s, obj) { return s.mz && s.mz.hs.filter(function (r) { return r.obj === obj; })[0]; }

function svgEl(w, paths, stroke, sw) {
  var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', w); svg.setAttribute('height', w); svg.setAttribute('fill', 'none'); svg.setAttribute('aria-hidden', 'true');
  paths.forEach(function (d) { var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('stroke', stroke); p.setAttribute('stroke-width', sw); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); svg.appendChild(p); });
  return svg;
}
// Same arrow as the live tours (style.css / app.js): points up, centred in a 24 box.
function arrowUp() { return svgEl('16', ['M4 12 L12 4 L20 12 M12 4 V20'], '#001a1f', '2.5'); }
function toolBtn(cls, label, paths, onClick) {
  var b = document.createElement('button'); b.type = 'button'; b.className = 'tool ' + cls; b.title = label; b.setAttribute('aria-label', label);
  b.appendChild(svgEl('14', paths, 'currentColor', '2'));
  b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
  return b;
}
var PENCIL = ['M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z'];
var GOTO = ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'M10 17l5-5-5-5', 'M15 12H3'];
var TRASH = ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'];

function renderHotspots(s) {
  if (!s.mz) return;
  var cont = s.mz.scene.hotspotContainer();
  s.mz.hs.forEach(function (r) { try { cont.destroyHotspot(r.h); } catch (e) {} });
  s.mz.hs = [];
  function build(type, obj, ariaLabel) {
    var b = document.createElement('div'); b.className = 'hs ' + (type === 'link' ? 'lnk' : 'info'); b.setAttribute('role', 'button'); b.tabIndex = 0; b.setAttribute('aria-label', ariaLabel);
    var mk = document.createElement('span'); mk.className = 'mk';
    if (type === 'link') mk.appendChild(arrowUp()); else mk.textContent = 'i';
    b.appendChild(mk);
    var rec = { obj: obj, type: type, el: b };
    b.appendChild(toolBtn('t-edit', type === 'link' ? 'Change linked scene' : 'Edit title', PENCIL, function () { openTool(s, rec); }));
    if (type === 'link') b.appendChild(toolBtn('t-go', 'Go to linked scene', GOTO, function () {
      var t = findScene(obj.target); if (t) showScene(state.scenes.indexOf(t));
    }));
    b.appendChild(toolBtn('t-del', 'Delete hotspot', TRASH, function () { removeHotspot(obj); }));
    var menu = document.createElement('div'); menu.className = 'hs-menu'; var box = document.createElement('div'); box.className = 'box'; menu.appendChild(box); b.appendChild(menu);
    rec.menu = menu; rec.box = box;
    return rec;
  }
  s.links.forEach(function (l) {
    var t = findScene(l.target); if (!t) return;
    var rec = build('link', l, 'Link to ' + t.name);
    var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = t.name; rec.el.appendChild(lbl); rec.lbl = lbl;
    rec.h = cont.createHotspot(rec.el, { yaw: l.yaw, pitch: l.pitch });
    var pe = rec.el.querySelector('.t-edit');
    pe.addEventListener('mouseenter', function () { rec.el.classList.remove('menu-closed'); prepMenu(s, rec); rec.el.classList.add('pop'); });
    rec.el.addEventListener('mouseleave', function () { rec.el.classList.remove('menu-closed', 'pop'); });
    rec.el.addEventListener('keydown', function (e) { if (e.target === rec.el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(l, 'link'); openTool(s, rec); } });
    s.mz.hs.push(rec); wireHs(s, rec);
  });
  s.infos.forEach(function (n) {
    var rec = build('info', n, n.title || 'Info');
    rec.h = cont.createHotspot(rec.el, { yaw: n.yaw, pitch: n.pitch });
    rec.el.addEventListener('keydown', function (e) { if (e.target === rec.el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(n, 'info'); } });
    s.mz.hs.push(rec); wireHs(s, rec);
  });
  markSelected();
}

// Pencil tool: link -> scene list; info -> title box.
function openTool(s, rec) {
  if (rec.type === 'link') { select(rec.obj, 'link'); rec.el.classList.remove('menu-closed'); prepMenu(s, rec); rec.el.classList.add('pop'); }
  else { select(rec.obj, 'info'); }
}

function menuHead(text, onClose) {
  var hd = document.createElement('div'); hd.className = 'hd'; var t = document.createElement('span'); t.textContent = text; hd.appendChild(t);
  var x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.setAttribute('aria-label', 'Close'); x.textContent = '×'; x.addEventListener('click', function (e) { e.stopPropagation(); onClose(); }); hd.appendChild(x);
  return hd;
}
// Info marker: a title box (the live tour shows the title as a hover tooltip).
function fillInfo(s, rec) {
  var box = rec.box; box.textContent = '';
  box.appendChild(menuHead('Title', function () { clearSel(); }));
  var inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 60; inp.placeholder = 'Title (required)'; inp.value = rec.obj.title || ''; inp.setAttribute('aria-label', 'Info title'); inp.className = 'ti';
  inp.addEventListener('input', function () { rec.obj.title = clean(inp.value, 60); rec.el.setAttribute('aria-label', rec.obj.title || 'Info'); });
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!rec.obj.title) return toast('Give the info point a title'); clearSel(); } });
  ['pointerdown', 'mousedown', 'touchstart'].forEach(function (n) { inp.addEventListener(n, function (e) { e.stopPropagation(); }); });
  box.appendChild(inp);
  var h = document.createElement('div'); h.className = 'note'; h.textContent = 'Visitors see this when they hover the marker.'; box.appendChild(h);
  if (!rec.obj.title) setTimeout(function () { inp.focus(); }, 30);
}

// Hover menu on a link hotspot: scenes listed by name, in tour order.
function prepMenu(s, rec) {
  if (!rec.menu) return;
  var box = rec.box; box.textContent = '';
  box.appendChild(menuHead('Select target scene', function () { rec.el.classList.remove('pop'); rec.el.classList.add('menu-closed'); }));
  state.scenes.forEach(function (x, i) {
    if (x === s) return;
    var b = document.createElement('button'); b.type = 'button'; b.className = 'opt' + (x.id === rec.obj.target ? ' on' : '');
    var n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1);
    var t = document.createElement('span'); t.className = 't'; t.textContent = x.name;
    b.appendChild(n); b.appendChild(t);
    b.addEventListener('click', function (e) { e.stopPropagation(); pickTarget(s, rec, x); });
    box.appendChild(b);
  });
  // keep the menu inside the panorama: flip up near the bottom, align to an edge near the sides
  var m = rec.menu; m.classList.remove('up', 'l', 'r');
  var pr = $('pano').getBoundingClientRect(), r = rec.el.getBoundingClientRect();
  var h = Math.min(250, 40 + (state.scenes.length - 1) * 38) + 16, cx = r.left + r.width / 2;
  if (r.bottom + h > pr.bottom && r.top - h > pr.top) m.classList.add('up');
  if (cx - 116 < pr.left) m.classList.add('l'); else if (cx + 116 > pr.right) m.classList.add('r');
}
function pickTarget(s, rec, t) {
  rec.obj.target = t.id; rec.lbl.textContent = t.name; rec.el.setAttribute('aria-label', 'Link to ' + t.name);
  rec.el.classList.remove('pop'); rec.el.classList.add('menu-closed');
  prepMenu(s, rec); renderScenes(); syncPublish();
}

// Click a hotspot to edit it; drag it to move it.
function wireHs(s, rec) {
  var el = rec.el;
  ['mousedown', 'touchstart', 'wheel'].forEach(function (n) { el.addEventListener(n, function (e) { e.stopPropagation(); }, { passive: true }); });
  el.addEventListener('pointerdown', function (e) {
    e.stopPropagation(); if (e.button > 0) return;
    if (e.target.closest && e.target.closest('.hs-menu, .tool')) return;
    var d = { x: e.clientX, y: e.clientY, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch (x) {}
    function mv(ev) {
      if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 5) return;
      d.moved = true; select(rec.obj, rec.type); el.classList.add('dragging');
      var r = $('pano').getBoundingClientRect();
      var c = s.mz.view.screenToCoordinates({ x: ev.clientX - r.left, y: ev.clientY - r.top });
      rec.obj.yaw = r4(c.yaw); rec.obj.pitch = r4(c.pitch); rec.h.setPosition({ yaw: rec.obj.yaw, pitch: rec.obj.pitch });
    }
    function up() {
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      try { el.releasePointerCapture(e.pointerId); } catch (x) {}
      el.classList.remove('dragging');
      if (!d.moved) { select(rec.obj, rec.type); el.classList.remove('menu-closed'); if (rec.type === 'link') prepMenu(s, rec); }
    }
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}

function markSelected() {
  var s = curScene(); if (!s || !s.mz) return;
  s.mz.hs.forEach(function (r) { r.el.classList.toggle('sel', !!state.sel && r.obj === state.sel.obj); });
}

function select(obj, type) {
  if (state.sel && state.sel.obj === obj) return;
  if (state.sel) clearSel();
  state.sel = { obj: obj, type: type };
  var cs = curScene(), rr = cs && hsRec(cs, obj); if (rr) { if (rr.type === 'link') prepMenu(cs, rr); else fillInfo(cs, rr); }
  markSelected(); syncAutorotate();
}

function removeHotspot(obj) {
  var s = curScene(); if (!s) return;
  s.links = s.links.filter(function (l) { return l !== obj; }); s.infos = s.infos.filter(function (n) { return n !== obj; });
  if (state.sel && state.sel.obj === obj) { state.sel = null; syncAutorotate(); }
  renderHotspots(s); renderScenes(); syncPublish();
}

function clearSel() {
  if (!state.sel) return;
  var sel = state.sel; state.sel = null;
  var cs0 = curScene(), r0 = cs0 && hsRec(cs0, sel.obj); if (r0) r0.el.classList.remove('pop');
  if (sel.type === 'info' && !String(sel.obj.title || '').trim()) {           // untitled info point is discarded
    var s = curScene(); if (s) { s.infos = s.infos.filter(function (n) { return n !== sel.obj; }); renderHotspots(s); }
  }
  markSelected(); syncAutorotate(); renderScenes(); syncPublish();
}

function addLink() {
  var s = curScene(); if (!s || !s.mz) return toast('Add a scene first');
  if (state.scenes.length < 2) return toast('Add a second scene to link to');
  var others = state.scenes.filter(function (x) { return x !== s; }), i = state.scenes.indexOf(s);
  var def = state.scenes[i + 1] || others[0];
  var l = { yaw: r4(s.mz.view.yaw()), pitch: r4(s.mz.view.pitch()), target: def.id };
  s.links.push(l); renderHotspots(s); select(l, 'link'); var rc = hsRec(s, l); if (rc) { prepMenu(s, rc); rc.el.classList.add('pop'); } renderScenes(); syncPublish();
}
function addInfo() {
  var s = curScene(); if (!s || !s.mz) return toast('Add a scene first');
  var n = { yaw: r4(s.mz.view.yaw()), pitch: r4(s.mz.view.pitch()), title: '', text: '' };
  s.infos.push(n); renderHotspots(s); select(n, 'info');
}

function onPanoTap() { if (state.sel) clearSel(); }

/* ---------- tiling ---------- */
function setProgress(text, frac) {
  $('prog').style.display = text ? 'block' : 'none';
  $('prog-t').textContent = text || ''; $('prog-b').style.width = Math.round((frac || 0) * 100) + '%';
}
function showErr(m) { var e = $('err'); e.textContent = m || ''; e.style.display = m ? 'block' : 'none'; }

async function tileScene(file, idx, total, cap, uid) {
  var label = 'Scene ' + (idx + 1) + '/' + total + ': ';
  var bmp = await createImageBitmap(file);
  var ratio = bmp.width / bmp.height, origW = bmp.width;
  if (Math.abs(ratio - 2) > 0.03) { bmp.close(); throw new Error('"' + (file.name || 'image') + '" is ' + bmp.width + '×' + bmp.height + '. Needs a 2:1 equirectangular panorama.'); }
  if (bmp.width < 2048) { bmp.close(); throw new Error('Image is too small (' + bmp.width + ' px wide). Use at least 2048 px.'); }
  var F = G.pickFaceSize(bmp.width, cap);
  var W = Math.min(bmp.width, 4 * F), H = Math.round(W / 2);
  setProgress(label + 'reading image…', 0);
  var sc = mkCanvas(W, H), sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high'; sctx.drawImage(bmp, 0, 0, W, H); bmp.close();
  var src = sctx.getImageData(0, 0, W, H).data;
  var thumb = mkCanvas(192, 96); thumb.getContext('2d').drawImage(sc, 0, 0, 192, 96); sc.width = 0;

  var levels = G.buildLevels(F), sizes = levels.map(function (l) { return l.size; });
  var id = uid + '-' + G.slugify((file.name || 'scene').replace(/\.[^.]+$/, ''));
  var tiles = new Map(), fallbackCanvases = {}, bytes = 0, files = 0, CH = 48;

  for (var fi = 0; fi < G.FACES.length; fi++) {
    var face = G.FACES[fi];
    var fc = mkCanvas(F, F), fctx = fc.getContext('2d'), img = fctx.createImageData(F, F);
    for (var r = 0; r < F; r += CH) {
      G.renderFaceRows(src, W, H, face, F, r, Math.min(F, r + CH), img.data);
      setProgress(label + 'face ' + (fi + 1) + '/6', (fi + r / F) / 6 * 0.85);
      await tick();
    }
    fctx.putImageData(img, 0, 0);
    // downscale ladder (halving keeps quality)
    var ladder = {}; ladder[F] = fc; var prev = fc;
    for (var s = F / 2; s >= 256; s /= 2) {
      var c2 = mkCanvas(s, s), x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(prev, 0, 0, s, s); ladder[s] = c2; prev = c2;
    }
    fallbackCanvases[face] = ladder[256];
    for (var z = 1; z < levels.length; z++) {
      var size = sizes[z], n = size / 512, lc = ladder[size];
      for (var ty = 0; ty < n; ty++) for (var tx = 0; tx < n; tx++) {
        var tc = mkCanvas(512, 512); tc.getContext('2d').drawImage(lc, tx * 512, ty * 512, 512, 512, 0, 0, 512, 512);
        var blob = await toBlob(tc, 'image/jpeg', 0.85); tc.width = 0;
        tiles.set(G.tileKey(id, z, face, ty, tx), blob); bytes += blob.size; files++;
      }
      await tick();
    }
    Object.keys(ladder).forEach(function (k) { if (ladder[k] !== ladder[256]) ladder[k].width = 0; });
  }
  setProgress(label + 'building preview…', 0.92);
  var pc = mkCanvas(256, 256 * 6), pctx = pc.getContext('2d'), fallback;
  for (var i = 0; i < 6; i++) { var f2 = G.PREVIEW_ORDER[i]; pctx.drawImage(fallbackCanvases[f2], 0, i * 256); }
  fallback = fallbackCanvases;
  var previewBlob = await toBlob(pc, 'image/jpeg', 0.85); pc.width = 0;
  tiles.set(id + '/preview.jpg', previewBlob); bytes += previewBlob.size; files++;

  var name = G.defaultSceneName(file.name, state.scenes.length + 1);
  return { id: id, thumb: thumb, name: name, faceSize: F, srcWidth: origW, capped: F < cap, levels: levels, tiles: tiles, fallback: fallback, bytes: bytes, files: files,
    start: { yaw: 0, pitch: 0, fov: MAX_VFOV }, links: [], infos: [], mz: null };
}

/* ---------- tiling worker (PIECE5) ---------- */
// The heavy work (decode, six cube faces, downscale ladder, JPEG encodes) runs in a Web Worker built from an
// inline Blob (build.js embeds core.js + worker.js in #g360-worker-src), so the page never freezes. The worker
// returns plain data (blobs + numbers) and the scene is built by sceneFromRecord(), the same path a restored
// draft uses. If workers or OffscreenCanvas are missing or fail, tileScene() above does the job on the main
// thread exactly as before.
//   error kind 'user'        -> the photo is unusable (wrong shape / too small): show it, don't retry
//   error kind 'unsupported' -> worker can't do this here: stop using it for the session, use the main thread
//   error kind 'broken'      -> worker failed to start or crashed: same as unsupported
//   error kind 'failed'      -> anything else: retry THIS scene on the main thread, keep the worker for the next
var tileWorker = null, workerOk = null;
function workerSupported() {
  if (workerOk === null) {
    workerOk = typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function' && typeof OffscreenCanvas !== 'undefined' &&
      typeof OffscreenCanvas.prototype.convertToBlob === 'function' && !!$('g360-worker-src');
  }
  return workerOk;
}
function getTileWorker() {
  if (tileWorker) return tileWorker;
  var url = URL.createObjectURL(new Blob([$('g360-worker-src').textContent], { type: 'text/javascript' }));
  tileWorker = new Worker(url);
  return tileWorker;
}
function retireTileWorker() { if (tileWorker) { try { tileWorker.terminate(); } catch (e) {} tileWorker = null; } }
function tileError(kind, message) { var e = new Error(message); e.kind = kind; return e; }

function tileSceneWorker(file, idx, total, cap, uid) {
  return new Promise(function (resolve, reject) {
    var w;
    try { w = getTileWorker(); } catch (e) { return reject(tileError('broken', (e && e.message) || 'the tiling worker could not start')); }
    var label = 'Scene ' + (idx + 1) + '/' + total + ': ';
    function detach() { w.onmessage = null; w.onerror = null; w.onmessageerror = null; }
    w.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.type === 'progress') { setProgress(m.text, m.frac); return; }
      detach();
      if (m.type === 'error') { if (m.kind === 'unsupported') retireTileWorker(); reject(tileError(m.kind || 'failed', m.message)); return; }
      if (m.type !== 'done' || !m.result) { retireTileWorker(); reject(tileError('broken', 'unexpected reply from the tiling worker')); return; }
      var r = m.result, blobs = r.tiles;
      blobs.set(D.thumbKey(r.id), r.thumbBlob);
      sceneFromRecord({
        id: r.id, name: G.defaultSceneName(file.name, state.scenes.length + 1), faceSize: r.faceSize, srcWidth: r.srcWidth,
        capped: r.capped, levels: r.levels, bytes: r.bytes, files: r.files,
        start: { yaw: 0, pitch: 0, fov: MAX_VFOV }, links: [], infos: [], blobs: blobs
      }).then(resolve, function (e) { reject(tileError('failed', (e && e.message) || String(e))); });
    };
    w.onerror = function (ev) { detach(); retireTileWorker(); reject(tileError('broken', (ev && ev.message) || 'the tiling worker crashed')); };
    w.onmessageerror = function () { detach(); retireTileWorker(); reject(tileError('broken', 'the tiling worker sent data that could not be read')); };
    w.postMessage({ type: 'tile', file: file, cap: cap, uid: uid, label: label });
  });
}

async function tileSceneAuto(file, idx, total, cap, uid) {
  if (workerSupported()) {
    try { return await tileSceneWorker(file, idx, total, cap, uid); }
    catch (e) {
      if (e && e.kind === 'user') throw e;
      if (e && (e.kind === 'unsupported' || e.kind === 'broken')) { workerOk = false; retireTileWorker(); }
      console.warn('Tiling worker failed (' + ((e && e.kind) || 'unknown') + '): ' + ((e && e.message) || e) + ' Using the main thread for this scene.');
    }
  }
  return tileScene(file, idx, total, cap, uid);
}

// Browser self-test: window.G360TileSelfTest() tiles the built-in demo panorama on the main thread AND in the
// worker, then compares them. It never touches your draft (no scenes are added or saved).
window.G360TileSelfTest = async function () {
  var out = [];
  function check(name, pass, detail) { out.push({ test: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) }); }
  function watch() {
    var last = performance.now(), worst = 0, t = setInterval(function () { var n = performance.now(); worst = Math.max(worst, n - last - 20); last = n; }, 20);
    return function () { clearInterval(t); return Math.max(0, Math.round(worst)); };
  }
  async function pixels(blob) {
    var b = await createImageBitmap(blob), c = mkCanvas(b.width, b.height), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(b, 0, 0); try { b.close(); } catch (e) {}
    var d = x.getImageData(0, 0, c.width, c.height).data; c.width = 0; return d;
  }
  function meanDiff(a, b) { if (a.length !== b.length) return Infinity; var s = 0, n = 0; for (var i = 0; i < a.length; i += 4) { s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; } return s / n; }
  var file = await demoFile(0), main = null, wrk = null, stallMain = null, stallWorker = null;
  try {
    var stop = watch(); main = await tileScene(file, 0, 1, 2048, 'selftest'); stallMain = stop();
    check('workers + OffscreenCanvas are supported here', workerSupported(), 'if this fails the editor uses the main-thread path');
    if (workerSupported()) { stop = watch(); wrk = await tileSceneWorker(file, 0, 1, 2048, 'selftest'); stallWorker = stop(); }
  } catch (e) { check('tiling ran without an error', false, (e && e.message) || e); }
  setProgress('');
  if (main && wrk) {
    var mk1 = Array.from(main.tiles.keys()).sort(), mk2 = Array.from(wrk.tiles.keys()).sort();
    check('same scene id', main.id === wrk.id, main.id + ' vs ' + wrk.id);
    check('same face size and levels', main.faceSize === wrk.faceSize && JSON.stringify(main.levels) === JSON.stringify(wrk.levels), main.faceSize + ' vs ' + wrk.faceSize);
    check('same set of tile keys', JSON.stringify(mk1) === JSON.stringify(mk2), mk1.length + ' vs ' + mk2.length);
    check('same file count', main.files === wrk.files, main.files + ' vs ' + wrk.files);
    var allJpeg = true;
    for (var pair of wrk.tiles) { var head = new Uint8Array(await pair[1].slice(0, 3).arrayBuffer()); if (head[0] !== 0xFF || head[1] !== 0xD8 || head[2] !== 0xFF) allJpeg = false; }
    check('every worker tile is a JPEG', allJpeg);
    var step = Math.max(1, Math.ceil(mk1.length / 8)), sample = mk1.filter(function (k, i) { return i % step === 0; });
    if (sample.indexOf(wrk.id + '/preview.jpg') < 0) sample.push(wrk.id + '/preview.jpg');
    var worst = 0;
    for (var i = 0; i < sample.length; i++) worst = Math.max(worst, meanDiff(await pixels(main.tiles.get(sample[i])), await pixels(wrk.tiles.get(sample[i]))));
    check('sampled tiles decode to the same pixels (mean diff <= 2/255)', worst <= 2, 'worst ' + worst.toFixed(2) + ' over ' + sample.length + ' tiles');
    check('page stays responsive during worker tiling (longest stall < 250 ms)', stallWorker < 250, 'longest stall: worker ' + stallWorker + ' ms, main-thread path ' + stallMain + ' ms');
  }
  var failed = out.filter(function (r) { return !r.pass; }).length;
  console.table(out);
  console.log('G360 tile self-test: ' + (failed ? failed + ' FAILED' : 'all ' + out.length + ' passed'));
  return { passed: out.length - failed, failed: failed, results: out };
};

async function addFiles(files) {
  if (state.busy || !files.length) return;
  if (state.orderLocked) { toast('Your order is already created for ' + state.scenes.length + ' scene(s), so scenes cannot be added now.'); return; }
  if (!ensureViewer()) return;
  if (state.scenes.length + files.length > LIMITS.scenes) { showErr('A tour can have at most ' + LIMITS.scenes + ' scenes (' + G.fmtMoney(G.priceFor(LIMITS.scenes).subtotal) + ' + GST).'); return; }
  showErr(''); state.busy = true; setBusy();
  var cap = 2048, added = 0;
  try {
    for (var i = 0; i < files.length; i++) {
      var s = await tileSceneAuto(files[i], i, files.length, cap, state.nextId++); // PIECE5
      state.scenes.push(s); buildMz(s); added++; persistNewScene(s);
      if (state.cur < 0) showScene(state.scenes.length - 1, true); else { renderScenes(); syncPublish(); }
    }
    toast(added + (added === 1 ? ' scene' : ' scenes') + ' ready');
  } catch (e) { console.error(e); showErr(e.message || String(e)); }
  setProgress('Saving your draft…', 1); await persistIdle();
  state.busy = false; setBusy(); setProgress('');
}
function setBusy() { ['add', 'empty-add', 'empty-demo'].forEach(function (id) { $(id).disabled = state.busy; }); }

/* ---------- demo panoramas (procedural 2:1 equirect) ---------- */
async function demoFile(kind) {
  var W = 4096, H = 2048, c = mkCanvas(W, H), x = c.getContext('2d');
  var pal = kind === 0 ? ['#7dc3e8', '#eaf6ff', '#b58a5a', '#5b4128', '#0f766e'] : ['#f2b880', '#fff1dd', '#7fa47f', '#35533a', '#b45309'];
  var g = x.createLinearGradient(0, 0, 0, H / 2); g.addColorStop(0, pal[0]); g.addColorStop(1, pal[1]); x.fillStyle = g; x.fillRect(0, 0, W, H / 2);
  var g2 = x.createLinearGradient(0, H / 2, 0, H); g2.addColorStop(0, pal[2]); g2.addColorStop(1, pal[3]); x.fillStyle = g2; x.fillRect(0, H / 2, W, H / 2);
  x.lineWidth = 3;
  for (var yaw = -180; yaw < 180; yaw += 15) {
    var px = W * (0.5 + yaw / 360), major = yaw % 45 === 0;
    x.strokeStyle = major ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.18)'; x.beginPath(); x.moveTo(px, 0); x.lineTo(px, H); x.stroke();
    if (major) { x.fillStyle = '#000'; x.font = 'bold 44px system-ui,sans-serif'; x.textAlign = 'center'; x.fillText(yaw + '°', px, H / 2 + 120); x.fillText(yaw + '°', px, H / 2 - 90); }
  }
  for (var lat = -75; lat <= 75; lat += 15) { var py = H * (0.5 - lat / 180); x.strokeStyle = lat === 0 ? 'rgba(0,0,0,.7)' : 'rgba(0,0,0,.18)'; x.lineWidth = lat === 0 ? 6 : 3; x.beginPath(); x.moveTo(0, py); x.lineTo(W, py); x.stroke(); }
  var names = [['FRONT', 0], ['RIGHT', 90], ['BACK', 180], ['LEFT', -90]];
  x.fillStyle = pal[4]; x.textAlign = 'center';
  names.forEach(function (n) { var px = W * (0.5 + n[1] / 360); if (n[1] === 180) { [W * 0.0, W].forEach(function (p) { x.font = 'bold 110px system-ui,sans-serif'; x.fillText('BACK', p === 0 ? 150 : W - 150, H / 2 - 260); }); } else { x.font = 'bold 130px system-ui,sans-serif'; x.fillText(n[0], px, H / 2 - 250); } });
  [[30, 200, 60], [-60, 260, 90], [130, 220, 50], [-140, 300, 110]].forEach(function (b, i) { var px = W * (0.5 + b[0] / 360); x.fillStyle = i % 2 ? pal[4] : 'rgba(30,30,30,.85)'; x.fillRect(px - b[2], H / 2 - b[1], b[2] * 2, b[1] + 160); });
  x.fillStyle = '#000'; x.font = 'bold 90px system-ui,sans-serif'; x.fillText(kind === 0 ? 'ROOM A' : 'ROOM B', W / 2, H * 0.12); x.fillText('▲ ceiling', W / 2, H * 0.03 + 60); x.fillText('floor ▼', W / 2, H * 0.94);
  var blob = await toBlob(c, 'image/jpeg', 0.9); c.width = 0;
  return new File([blob], kind === 0 ? 'Room A.jpg' : 'Room B.jpg', { type: 'image/jpeg' });
}

/* ---------- rendering panels ---------- */
function renderScenes() {
  var box = $('scene-list'); box.textContent = '';
  state.scenes.forEach(function (s, i) {
    var d = document.createElement('div'); d.className = 'scard' + (i === state.cur ? ' cur' : ''); d.dataset.i = String(i);
    d.setAttribute('role', 'button'); d.tabIndex = 0; d.setAttribute('aria-label', 'Scene ' + (i + 1) + ': ' + s.name);
    var grip = document.createElement('span'); grip.className = 'grip'; grip.textContent = '⋮⋮'; grip.title = 'Drag to reorder'; d.appendChild(grip);
    var th = document.createElement('div'); th.className = 'thumb';
    var cv = mkCanvas(192, 96); if (s.thumb) cv.getContext('2d').drawImage(s.thumb, 0, 0); th.appendChild(cv);
    var num = document.createElement('span'); num.className = 'num'; num.textContent = String(i + 1); th.appendChild(num);
    var del = document.createElement('button'); del.type = 'button'; del.className = 'del'; del.textContent = '×'; del.title = 'Delete scene'; del.setAttribute('aria-label', 'Delete scene ' + (i + 1)); del.addEventListener('click', function (e) { e.stopPropagation(); removeScene(i); }); th.appendChild(del); d.appendChild(th);
    var info = document.createElement('div'); info.className = 'sinfo';
    var nm = document.createElement('div'); nm.className = 'sname'; nm.textContent = s.name; info.appendChild(nm);
    var m = document.createElement('div'); m.className = 'smeta' + (i === 0 ? ' start' : ''); m.textContent = (i === 0 ? 'Start · ' : '') + s.links.length + ' link' + (s.links.length === 1 ? '' : 's') + (s.capped ? ' · ' + s.faceSize + ' px' : ''); m.title = s.capped ? 'Limited by photo width (' + s.srcWidth + ' px)' : ''; info.appendChild(m);
    d.appendChild(info);
    d.addEventListener('click', function () { if (dragged) return; showScene(i); });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showScene(i); }
      else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveScene(i, i - 1, true); }
      else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveScene(i, i + 1, true); }
    });
    box.appendChild(d);
  });
  $('hstat').textContent = state.scenes.length ? state.scenes.length + ' scene' + (state.scenes.length > 1 ? 's' : '') : '';
}

function moveScene(from, to, refocus) {
  if (from === to || to < 0 || to >= state.scenes.length || from < 0) return;
  var cur = curScene(), s = state.scenes.splice(from, 1)[0];
  state.scenes.splice(to, 0, s); state.cur = state.scenes.indexOf(cur);
  renderScenes(); syncPublish();
  if (refocus) { var el = $('scene-list').children[to]; if (el) el.focus(); }
}

/* pointer-based drag to reorder (mouse anywhere on a card; touch via the grip) */
var dragged = false;
(function () {
  var list = $('scene-list'), st = null;
  list.addEventListener('pointerdown', function (e) {
    var card = e.target.closest && e.target.closest('.scard');
    if (!card || (e.target.closest && e.target.closest('button'))) return;
    if (e.pointerType === 'touch' && !(e.target.closest && e.target.closest('.grip'))) return;
    if (e.button != null && e.button > 0) return;
    st = { card: card, from: +card.dataset.i, y0: e.clientY, active: false, to: +card.dataset.i, id: e.pointerId };
    try { card.setPointerCapture(e.pointerId); } catch (x) {}
  });
  list.addEventListener('pointermove', function (e) {
    if (!st) return;
    var dy = e.clientY - st.y0;
    if (!st.active) { if (Math.abs(dy) < 6) return; st.active = true; dragged = true; st.card.classList.add('dragging'); }
    st.card.style.transform = 'translateY(' + dy + 'px)';
    var cards = Array.prototype.slice.call(list.children), target = st.from, y = e.clientY;
    cards.forEach(function (c, i) { c.classList.remove('drop-before', 'drop-after'); });
    for (var i = 0; i < cards.length; i++) {
      if (i === st.from) continue;
      var r = cards[i].getBoundingClientRect(), mid = r.top + r.height / 2;
      if (i < st.from && y < mid) { target = i; break; }
      if (i > st.from && y > mid) target = i;
    }
    st.to = target;
    if (target !== st.from) cards[target].classList.add(target < st.from ? 'drop-before' : 'drop-after');
  });
  function end(e) {
    if (!st) return; var s = st; st = null;
    try { s.card.releasePointerCapture(s.id); } catch (x) {}
    if (s.active) { s.card.classList.remove('dragging'); s.card.style.transform = ''; moveScene(s.from, s.to); setTimeout(function () { dragged = false; }, 50); }
  }
  list.addEventListener('pointerup', end); list.addEventListener('pointercancel', end);
})();

function removeScene(i) {
  var s = state.scenes[i]; if (!s) return;
  if (state.orderLocked) { toast('Scenes cannot be removed after your order is created.'); return; }
  if (state.sel) clearSel();
  state.scenes.splice(i, 1);
  state.scenes.forEach(function (o) { o.links = o.links.filter(function (l) { return l.target !== s.id; }); });
  try { viewer.destroyScene(s.mz.scene); } catch (e) {}
  state.scenes.forEach(renderHotspots);
  if (!state.scenes.length) { state.cur = -1; $('empty').style.display = 'flex'; renderScenes(); syncPublish(); return; }
  showScene(Math.min(i, state.scenes.length - 1), true);
}

function buildAppData() {
  return {
    scenes: state.scenes.map(function (s) {
      return { id: s.id, name: s.name, levels: s.levels, faceSize: s.faceSize,
        initialViewParameters: { yaw: r4(s.start.yaw), pitch: r4(s.start.pitch), fov: r4(s.start.fov) },
        linkHotspots: s.links.map(function (l) { return { yaw: l.yaw, pitch: l.pitch, rotation: 0, target: l.target }; }),
        infoHotspots: s.infos.map(function (n) { return { yaw: n.yaw, pitch: n.pitch, title: n.title, text: n.text }; }) };
    }),
    name: (G.validateAddress(state.details.address).value || 'Untitled tour'),
    settings: (function () {
      var st = { mouseViewMode: 'drag', autorotateEnabled: true, fullscreenButton: false, viewControlButtons: false };
      var u = G.normalizeListingUrl(state.details.url); if (u.ok && u.value) st.listingUrl = u.value;
      return st;
    })()
  };
}

function totals() { var b = 0, f = 0; state.scenes.forEach(function (s) { b += s.bytes; f += s.files; }); return { bytes: b, files: f }; }
function unlinkedScenes() {
  return state.scenes.filter(function (s, i) { return i > 0 && !state.scenes.some(function (o) { return o.links.some(function (l) { return l.target === s.id; }); }); });
}
function syncPublish() {
  var t = totals();
  var n = state.scenes.length, okCount = G.validateSceneCount(n).ok;
  $('publish').disabled = !okCount || t.bytes > LIMITS.bytes;
  $('publish').textContent = n ? 'Publish · ' + G.fmtMoney(G.priceFor(n).subtotal) + ' + GST' : 'Publish';
  var pn = $('price-note'); if (pn) pn.textContent = n ? (n + (n === 1 ? ' scene' : ' scenes') + ' × ' + G.fmtMoney(G.PRICING.perSceneCents) + ' = ' + G.fmtMoney(G.priceFor(n).subtotal) + ' + GST') : G.fmtMoney(G.PRICING.perSceneCents) + ' + GST per scene · ' + G.PRICING.minScenes + ' to ' + G.PRICING.maxScenes + ' scenes';
  updateTitle();
}
/* ---------- cover image (the link-preview image, uploaded as _og/preview.jpg) ---------- */
// Limits mirror the server (supabase/functions/_shared/limits.ts + ogImage.ts). The server is the
// authority; these exist so the customer finds out now, not after paying. A hair of margin on the
// aspect band so rounding after a resize can never land just outside what the server accepts.
var COVER = { maxBytes: 1000000 /* upload-urls caps every file at 1 MiB */, minW: 800, minH: 420, maxW: 2400, maxH: 2100, minAspect: 4 / 3 + 0.01, maxAspect: 2.4 - 0.01 };

async function processCover(file) {
  if (!file || !/^image\//.test(file.type || '')) return { ok: false, error: 'Please choose an image file (JPEG, PNG or WebP).' };
  var bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { return { ok: false, error: 'That image could not be read. If it is a HEIC photo, convert it to JPEG first.' }; }
  var w = bmp.width, h = bmp.height, aspect = w / h;
  if (w < COVER.minW || h < COVER.minH) { bmp.close(); return { ok: false, error: 'That image is too small (' + w + '×' + h + '). It needs to be at least ' + COVER.minW + '×' + COVER.minH + '.' }; }
  if (aspect < COVER.minAspect || aspect > COVER.maxAspect) { bmp.close(); return { ok: false, error: 'That image is the wrong shape (' + aspect.toFixed(2) + ':1). Use a landscape image between 4:3 and 2.4:1 (a normal wide photo or screenshot).' }; }
  var scale = Math.min(1, COVER.maxW / w, COVER.maxH / h);
  var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch); cx.drawImage(bmp, 0, 0, cw, ch); bmp.close();
  var blob = null, qs = [0.9, 0.82, 0.74, 0.66, 0.58];
  for (var i = 0; i < qs.length; i++) {
    blob = await new Promise(function (res) { cv.toBlob(res, 'image/jpeg', qs[i]); });
    if (blob && blob.size <= COVER.maxBytes) break;
  }
  if (!blob || blob.type !== 'image/jpeg') return { ok: false, error: 'Could not prepare that image as a JPEG. Try a different image.' };
  if (blob.size > COVER.maxBytes) return { ok: false, error: 'That image is too large even after compression. Try a smaller one.' };
  return { ok: true, blob: blob, width: cw, height: ch };
}

// Stored with the draft so a reload (or the Stripe round trip) keeps it. A failed save never blocks editing.
function persistCover(blob) {
  return enqueue(async function () {
    if (!persist.id) persist.id = await D.startNew();
    if (blob) await D.saveBlob(persist.id, D.COVER_KEY, blob); else await D.deleteBlob(persist.id, D.COVER_KEY);
    persist.everSaved = true;
  });
}

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // same shape the server's notification code uses
function checkName(v) { v = clean(v, 100); return v ? { ok: true, value: v } : { ok: false, error: 'Please enter your name.' }; }
function checkEmail(v) { v = String(v).trim(); return (v.length <= 254 && EMAIL_RE.test(v)) ? { ok: true, value: v } : { ok: false, error: 'Please enter a valid email address.' }; }

/* ---------- publish flow (PIECE6) ---------- */
// Create the order, upload every tile plus the cover image, finalize, then wait for publication.
// Every step is safe to repeat: create-order is idempotent on the draft id, uploads overwrite the same keys,
// finalize is idempotent. What must survive a reload (order id, slug, RESUME TOKEN, status) is saved into the
// draft BEFORE anything else happens, because the server hands the token out only once.
// Once an order exists the scene count is paid for and the file set is fixed, so adding/removing scenes and
// editing name, email, address and link are locked (state.orderLocked). Scene names, order, hotspots, start
// views, the visibility choice and the cover image can still change.
var publishing = false;
var PUB = { pollMs: 2000, pollMaxMs: 180000, payConfirmMaxMs: 120000, chunk: 100, parallel: 6, tries: 3, backoffMs: 800, minBytes: 100, maxBytes: 1048576, coverKey: '_og/preview.jpg' };
var liveTokens = {}, uploadedKeys = {};
var paymentRedirect = false, confirmingPayment = false; // PIECE7
// Set when Stripe has just sent the customer back (?order=<id>, plus &cancelled=1 if they backed out). Read ONCE at load.
var paymentReturn = (function () {
  try {
    var q = new URLSearchParams(location.search), id = q.get('order');
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    return { orderId: id.toLowerCase(), cancelled: q.get('cancelled') === '1' };
  } catch (e) { return null; }
})();
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function liveLink(slug) { return G360Api.toursBase + '/' + slug + '/'; }
function pubErr(message, opts) { var e = new Error(message); opts = opts || {}; e.back = !!opts.back; e.retry = opts.retry !== false; return e; }
function fieldText(fields) { return fields && typeof fields === 'object' ? ' ' + Object.keys(fields).map(function (k) { return fields[k]; }).join(' ') : ''; }
function saveOrderMeta(draftId, patch) { return D.saveMeta(draftId, patch).then(function () { return true; }, function () { return false; }); }

window.addEventListener('beforeunload', function (e) { if (publishing && !paymentRedirect) { e.preventDefault(); e.returnValue = ''; return ''; } });

function pubView() {
  var body = $('modal-b'); body.textContent = ''; $('modal-t').textContent = 'Publishing your tour';
  $('modal-go').style.display = 'none';
  var rows = [], list = document.createElement('div'); list.className = 'list';
  ['Create your order', 'Upload your photos', 'Publish your tour'].forEach(function (name) {
    var r = document.createElement('div'); r.style.cssText = 'display:flex;gap:10px;align-items:baseline';
    var m = document.createElement('span'); m.style.cssText = 'width:16px;text-align:center;flex:0 0 auto'; m.textContent = '○';
    var t = document.createElement('div'); t.style.cssText = 'flex:1;min-width:0';
    var a = document.createElement('div'); a.style.fontWeight = '600'; a.textContent = name;
    var d = document.createElement('div'); d.className = 'muted';
    t.appendChild(a); t.appendChild(d); r.appendChild(m); r.appendChild(t); list.appendChild(r); rows.push({ m: m, d: d });
  });
  body.appendChild(list);
  var bar = document.createElement('div'), fill = document.createElement('i'); bar.className = 'bar'; bar.style.display = 'none'; bar.appendChild(fill); body.appendChild(bar);
  var warn = document.createElement('p'); warn.className = 'muted wn'; warn.style.display = 'none'; body.appendChild(warn);
  var note = document.createElement('p'); note.className = 'muted'; note.style.display = 'none'; body.appendChild(note);
  var err = document.createElement('p'); err.className = 'err'; err.style.display = 'none'; body.appendChild(err);
  var acts = document.createElement('div'); acts.className = 'row'; body.appendChild(acts);
  var ICON = { todo: ['○', ''], doing: ['…', ''], done: ['✓', 'ok'], fail: ['✕', 'no'] };
  function setText(el, t) { el.textContent = t || ''; el.style.display = t ? 'block' : 'none'; }
  return {
    step: function (i, st, detail) { rows[i].m.textContent = ICON[st][0]; rows[i].m.className = ICON[st][1]; if (detail !== undefined) rows[i].d.textContent = detail; },
    bar: function (f) { bar.style.display = f == null ? 'none' : 'block'; fill.style.width = Math.round(Math.max(0, Math.min(1, f || 0)) * 100) + '%'; },
    warn: function (t) { setText(warn, t); },
    note: function (t) { setText(note, t); },
    error: function (t) { setText(err, t); },
    actions: function (list2) {
      acts.textContent = '';
      list2.forEach(function (a) { var b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (a.primary ? ' pri' : ''); b.textContent = a.label; b.addEventListener('click', a.run); acts.appendChild(b); });
    },
    link: function (url) {
      var p = document.createElement('p'), a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = url; a.style.cssText = 'color:var(--link);word-break:break-all';
      p.appendChild(a); body.insertBefore(p, warn);
    }
  };
}

function finishPublished(ui, slug) {
  ui.step(0, 'done'); ui.step(1, 'done'); ui.step(2, 'done', 'Your tour is published'); ui.bar(null); ui.error('');
  $('modal-t').textContent = 'Your tour is live';
  ui.link(liveLink(slug));
  ui.note('It can take a minute or two for the page to appear while the site updates. We have also emailed you the link.');
  ui.actions([{ label: 'Start a new tour', primary: true, run: startNewTour }]);
}

async function startNewTour() {
  if (!confirm('Start a new tour? This clears the finished tour from this browser. The published tour stays live.')) return;
  try { await persistIdle(); if (persist.id) await D.clearDraft(persist.id); } catch (e) { /* reload anyway */ }
  location.reload();
}

async function requestUrls(orderId, token, chunk) {
  var res = await G360Api.requestUploadUrls(orderId, token, chunk.map(function (it) { return { key: it.key, size: it.blob.size }; }));
  if (!res.ok) {
    if (res.status === 401 || res.status === 404) throw pubErr('This browser could not prove access to your order. Check your email for the link we sent, or contact us and quote your order number.', { retry: false });
    if (res.status === 409) throw pubErr('This order is not accepting uploads right now (' + res.error + '). Reload the page to see where it is up to.', { retry: false });
    throw pubErr(res.error, {});
  }
  var map = new Map(); ((res.body && res.body.urls) || []).forEach(function (u) { map.set(u.key, u.url); });
  chunk.forEach(function (it) { if (!map.has(it.key)) throw pubErr('The server did not return an upload address for ' + it.key + '.', {}); });
  return map;
}

// One file: retry with backoff, asking for a FRESH address each retry (an expired signed address looks like a plain
// network error to the browser, so we can't tell the two apart).
async function putOne(it, url, orderId, token, onProg) {
  var u = url;
  for (var attempt = 1; attempt <= PUB.tries; attempt++) {
    var r; try { r = await G360Api.uploadToR2(u, it.blob, onProg); } catch (e) { r = { ok: false }; }
    if (r && r.ok) return true;
    if (attempt < PUB.tries) {
      await sleep(PUB.backoffMs * attempt);
      try { var fresh = await requestUrls(orderId, token, [it]); u = fresh.get(it.key) || u; } catch (e) { /* keep the old address */ }
    }
  }
  return false;
}

async function runPool(items, n, fn) {
  var i = 0, lanes = [];
  for (var k = 0; k < Math.min(n, items.length); k++) lanes.push((async function () { while (i < items.length) { var it = items[i++]; await fn(it); } })());
  await Promise.all(lanes);
}

async function uploadAll(ui, orderId, token) {
  var items = [];
  state.scenes.forEach(function (s) { s.tiles.forEach(function (blob, key) { items.push({ key: key, blob: blob }); }); });
  items.push({ key: PUB.coverKey, blob: state.cover });
  var odd = items.filter(function (it) { return it.blob.size < PUB.minBytes || it.blob.size > PUB.maxBytes; })[0];
  if (odd) {
    if (odd.key === PUB.coverKey) throw pubErr('Your cover image is larger than the 1 MB limit. Please choose it again.', { back: true, retry: false });
    throw pubErr('One of your photo tiles has an unexpected size (' + odd.key + '). Please contact us.', { retry: false });
  }
  var done = uploadedKeys[orderId] || (uploadedKeys[orderId] = {});
  var total = 0, sent = 0, count = 0, inflight = {}, lastPaint = 0;
  items.forEach(function (it) { total += it.blob.size; if (done[it.key]) { sent += it.blob.size; count++; } });
  function paint(force) {
    var now = Date.now(); if (!force && now - lastPaint < 120) return; lastPaint = now;
    var part = 0; for (var k in inflight) part += inflight[k];
    var frac = total ? Math.min(1, (sent + part) / total) : 1;
    ui.bar(frac); ui.step(1, 'doing', 'Uploading ' + count + ' of ' + items.length + ' files (' + Math.floor(frac * 100) + '%)');
  }
  paint(true);
  var todo = items.filter(function (it) { return !done[it.key]; });
  for (var c = 0; c < todo.length; c += PUB.chunk) {
    var chunk = todo.slice(c, c + PUB.chunk), urls = await requestUrls(orderId, token, chunk), failed = [];
    await runPool(chunk, PUB.parallel, async function (it) {
      var ok = await putOne(it, urls.get(it.key), orderId, token, function (f) { inflight[it.key] = f * it.blob.size; paint(false); });
      delete inflight[it.key];
      if (ok) { done[it.key] = true; sent += it.blob.size; count++; } else failed.push(it.key);
      paint(false);
    });
    if (failed.length) throw pubErr(failed.length + ' of ' + items.length + ' files could not be uploaded (' + failed[0] + (failed.length > 1 ? ' and others' : '') + '). Check your connection and try again. Files already uploaded are kept.', {});
  }
  paint(true);
}

async function publishTour(ui) {
  var d = state.details;
  if (!state.scenes.length) throw pubErr('Add at least one scene first.', { back: true, retry: false });
  if (!state.cover) throw pubErr('Please add a cover image.', { back: true, retry: false });
  if (d.rightsConfirmed !== true) throw pubErr('Please confirm the ownership declaration.', { back: true, retry: false });
  if (state.cover.size > PUB.maxBytes || state.cover.size < PUB.minBytes) throw pubErr('Your cover image is larger than the 1 MB limit. Please choose it again.', { back: true, retry: false });

  // 1. the order
  ui.step(0, 'doing', 'Saving your details…');
  await persistIdle();
  var draftId = persist.id, storageOk = true, meta = null;
  if (!draftId) { try { draftId = persist.id = await D.startNew(); } catch (e) { draftId = crypto.randomUUID(); storageOk = false; } }
  if (storageOk) { try { meta = await D.loadMeta(draftId); } catch (e) { storageOk = false; } }
  var res = await G360Api.createOrder(draftId, { clientName: d.clientName, clientEmail: d.clientEmail, address: d.address, listingUrl: d.url, sceneCount: state.scenes.length, returnTo: location.origin + location.pathname });
  if (!res.ok) throw pubErr(res.error + fieldText(res.fields), { back: !!res.fields, retry: !res.fields });
  var b = res.body || {};
  var token = b.resumeToken || (meta && meta.resumeToken) || liveTokens[b.orderId];
  if (!token) throw pubErr('This order was started in another browser, or its saved key was lost, so it cannot be continued from here. Check your email for the link we sent, or contact us.', { retry: false });
  liveTokens[b.orderId] = token;
  state.orderLocked = true;
  if (!(await saveOrderMeta(draftId, { orderId: b.orderId, slug: b.slug, resumeToken: token, orderStatus: b.status }))) storageOk = false;
  if (!storageOk) ui.warn('This browser could not save your progress. Keep this tab open until publishing finishes.');
  ui.step(0, 'done', 'Order ' + b.slug);

  var status = b.status;
  if (status === 'published') return finishPublished(ui, b.slug);
  if (status === 'failed') throw pubErr('Publishing this order failed earlier. Your photos are safe and we have been notified, so you do not need to upload again.', { retry: false });
  if (status === 'draft' && confirmingPayment) {
    // Just back from Stripe: the webhook usually marks the order paid within seconds. Wait for it; never send them back to pay.
    ui.step(1, 'doing', 'Confirming your payment…');
    var tPay = Date.now();
    while (status === 'draft') {
      var pp = await G360Api.pollOrder(b.orderId, token);
      if (pp.ok && pp.body.status !== 'draft') { status = pp.body.status; break; }
      if (Date.now() - tPay > PUB.payConfirmMaxMs) throw pubErr('We have not received confirmation of your payment yet. This can take a minute. Click Try again in a moment. If you were charged, your order is safe and will carry on.', {});
      await sleep(PUB.pollMs);
    }
    confirmingPayment = false;
    await saveOrderMeta(draftId, { orderStatus: status });
    ui.step(1, 'done', 'Payment received');
  }
  if (status === 'draft') {
    if (b.checkoutUrl) {
      if (!/^https:\/\/checkout\.stripe\.com\//.test(b.checkoutUrl)) throw pubErr('The payment page address was not what we expected, so we have not sent you there. Please try again, or contact us.', { retry: false });
      ui.step(1, 'doing', 'Taking you to the secure payment page…');
      ui.note('You will pay on Stripe\u2019s secure page, then come straight back here. Your tour is saved.');
      await persistIdle();
      paymentRedirect = true; setTimeout(function () { paymentRedirect = false; }, 8000);
      location.href = b.checkoutUrl;
      return;
    }
    if (b.checkoutError) throw pubErr('We could not open the payment page (' + b.checkoutError + '). Please try again in a moment.', {});
    ui.step(1, 'todo', 'Waiting for payment');
    ui.note('Your order is saved. Payment is not switched on yet, so there is nothing more to do for now.');
    return;
  }
  if (status !== 'paid' && status !== 'uploaded') throw pubErr('This order is in an unexpected state (' + status + ').', { retry: false });

  // 2. the files, then 3. finalize
  if (status === 'paid') {
    await uploadAll(ui, b.orderId, token);
    ui.step(1, 'done', 'All files uploaded'); ui.bar(null);
    ui.step(2, 'doing', 'Checking your tour…');
    var fin = await G360Api.finalize(b.orderId, token, buildAppData(), d.unlisted === true, true);
    if (!fin.ok && fin.status !== 409) throw pubErr('We could not finish publishing: ' + fin.error, { back: /cover image/i.test(fin.error || ''), retry: true });
    await saveOrderMeta(draftId, { orderStatus: 'uploaded' });
  } else {
    // PIECE6B: already 'uploaded' = every file is stored, but publishing may never have started (or crashed).
    // finalize is idempotent for an uploaded order and simply starts publishing again, so ask it to.
    ui.step(1, 'done', 'All files uploaded');
    ui.step(2, 'doing', 'Restarting publishing…');
    var again = await G360Api.finalize(b.orderId, token, buildAppData(), d.unlisted === true, true);
    if (!again.ok && again.status !== 409) throw pubErr('We could not restart publishing: ' + again.error, { retry: true });
  }

  // 4. wait for it to go live
  ui.step(2, 'doing', 'Publishing…');
  var t0 = Date.now();
  while (true) {
    var p = await G360Api.pollOrder(b.orderId, token);
    if (p.ok) {
      if (p.body.status === 'published') { await saveOrderMeta(draftId, { orderStatus: 'published' }); return finishPublished(ui, p.body.slug || b.slug); }
      if (p.body.status === 'failed') {
        await saveOrderMeta(draftId, { orderStatus: 'failed' });
        throw pubErr('Publishing stopped at the "' + (p.body.errorStep || 'unknown') + '" step. Your photos are safe and we have been notified, so you do not need to upload again.', { retry: false });
      }
    } else if (p.status === 401 || p.status === 404) {
      throw pubErr('This browser could not prove access to your order any more. Check your email for the link we sent, or contact us.', { retry: false });
    }
    if (Date.now() - t0 > PUB.pollMaxMs) { ui.note('Still publishing. You can close this page: we will email you when your tour is live.'); return; }
    await sleep(PUB.pollMs);
  }
}

function showPaymentNotice(title, text) {
  var body = $('modal-b'); body.textContent = ''; $('modal-t').textContent = title; $('modal-go').style.display = 'none';
  var p = document.createElement('p'); p.textContent = text; body.appendChild(p); $('modal').style.display = 'flex';
}

async function handlePaymentReturn() {
  var pr = paymentReturn; if (!pr) return;
  paymentReturn = null; // handle it once
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* the address bar just keeps the query */ }
  var meta = null; try { if (persist.id) meta = await D.loadMeta(persist.id); } catch (e) { meta = null; }
  var mine = !!meta && meta.orderId === pr.orderId;
  if (pr.cancelled) { if (mine) toast('Payment cancelled. Your tour is saved: click Publish whenever you are ready.'); return; }
  if (!mine) {
    showPaymentNotice('We could not find your tour in this browser', 'If you completed a payment, it has been received, but the tour you were building is stored in the browser where you started it. Please open the editor there, or contact info@glow360.co.nz and quote this order number: ' + pr.orderId);
    return;
  }
  confirmingPayment = true;
  $('modal').style.display = 'flex';
  runPublish();
}

async function runPublish() {
  if (publishing) return;
  publishing = true;
  var ui = pubView();
  try { await publishTour(ui); }
  catch (e) {
    console.error('publish failed', e);
    var acts = [];
    if (e && e.back) acts.push({ label: 'Back to details', run: function () { publishing = false; openPublish(); } });
    if (!e || e.retry !== false) acts.push({ label: 'Try again', primary: true, run: function () { publishing = false; runPublish(); } });
    ui.error((e && e.message) || 'Something went wrong.');
    ui.actions(acts);
  } finally { publishing = false; }
}

function openPublish() {
  if (publishing) { $('modal').style.display = 'flex'; return; }
  var body = $('modal-b'); body.textContent = ''; $('modal-t').textContent = 'Tour details';
  var coverUrl = null;
  function setCoverPreview(img) { if (coverUrl) { URL.revokeObjectURL(coverUrl); coverUrl = null; } if (state.cover) { coverUrl = URL.createObjectURL(state.cover); img.src = coverUrl; img.style.display = 'block'; } else { img.removeAttribute('src'); img.style.display = 'none'; } }
  function field(labelText, id, value, ph, help) {
    var wrap = document.createElement('div'); wrap.style.marginBottom = '14px';
    var lab = document.createElement('label'); lab.className = 'modal-field'; lab.htmlFor = id; lab.textContent = labelText; wrap.appendChild(lab);
    var inp = document.createElement('input'); inp.type = 'text'; inp.id = id; inp.value = value; inp.placeholder = ph; inp.autocomplete = 'off'; wrap.appendChild(inp);
    if (help) { var h = document.createElement('div'); h.className = 'muted fh'; h.textContent = help; wrap.appendChild(h); }
    var e = document.createElement('p'); e.className = 'err'; e.id = id + '-err'; e.style.display = 'none'; wrap.appendChild(e);
    body.appendChild(wrap); return inp;
  }
  function checkRow(id, checked, text, help) {
    var wrap = document.createElement('div'); wrap.style.marginBottom = '14px';
    var lab = document.createElement('label'); lab.style.cssText = 'display:flex;gap:10px;align-items:flex-start;cursor:pointer;font-size:13.5px;line-height:1.4';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = id; cb.checked = checked; cb.style.cssText = 'margin-top:2px;flex:0 0 auto;width:16px;height:16px';
    var t = document.createElement('span'); t.textContent = text; lab.appendChild(cb); lab.appendChild(t); wrap.appendChild(lab);
    if (help) { var h = document.createElement('div'); h.className = 'muted fh'; h.style.marginLeft = '26px'; h.textContent = help; wrap.appendChild(h); }
    var e = document.createElement('p'); e.className = 'err'; e.id = id + '-err'; e.style.display = 'none'; e.style.marginLeft = '26px'; wrap.appendChild(e);
    body.appendChild(wrap); return cb;
  }

  var nameIn = field('Your name', 'd-name', state.details.clientName, 'Jane Smith', '');
  var emailIn = field('Your email', 'd-email', state.details.clientEmail, 'you@example.com', 'We email your tour link here when it is live.');
  nameIn.maxLength = 100; nameIn.autocomplete = 'name';
  emailIn.maxLength = 254; emailIn.setAttribute('inputmode', 'email'); emailIn.autocomplete = 'email'; emailIn.autocapitalize = 'off';
  var addr = field('Property address (tour title)', 'd-addr', state.details.address, 'e.g. 12 Example Street, Remuera, Auckland', 'Shown at the top of your tour and in link previews.');
  var url = field('Listing link (optional)', 'd-url', state.details.url, 'https://www.trademe.co.nz/… or zillow.com/…', 'Adds an “Open Listing Page” button to your tour. Paste the link from your agent’s listing (Trade Me, Zillow, etc).');
  addr.maxLength = 120; url.maxLength = 500; url.setAttribute('inputmode', 'url');
  if (state.orderLocked) {
    [nameIn, emailIn, addr, url].forEach(function (i) { i.disabled = true; i.title = 'Fixed once your order is created'; });
    var lockNote = document.createElement('p'); lockNote.className = 'muted wn'; lockNote.textContent = 'Your order has been created, so your name, email, address and listing link are now fixed. You can still change the cover image, the visibility choice and your hotspots.'; body.appendChild(lockNote);
  }

  // cover image
  var cw = document.createElement('div'); cw.style.marginBottom = '14px';
  var cl = document.createElement('div'); cl.className = 'modal-field'; cl.textContent = 'Cover image'; cw.appendChild(cl);
  var pv = document.createElement('img'); pv.alt = 'Cover image preview'; pv.style.cssText = 'display:none;width:100%;max-height:180px;object-fit:cover;border-radius:10px;border:1px solid var(--line);margin-bottom:8px'; cw.appendChild(pv);
  var cr = document.createElement('div'); cr.className = 'row'; cr.style.marginBottom = '0';
  var pick = document.createElement('button'); pick.type = 'button'; pick.className = 'btn sm'; pick.textContent = state.cover ? 'Change image' : 'Choose image'; cr.appendChild(pick);
  var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'btn sm dng'; rm.textContent = 'Remove'; rm.style.display = state.cover ? '' : 'none'; cr.appendChild(rm);
  cw.appendChild(cr);
  var fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.hidden = true; cw.appendChild(fi);
  var ch = document.createElement('div'); ch.className = 'muted fh'; ch.textContent = 'Shown when your link is shared (WhatsApp, Facebook, iMessage…). A wide landscape photo works best: at least ' + COVER.minW + '×' + COVER.minH + ', shaped between 4:3 and 2.4:1.'; cw.appendChild(ch);
  var ce = document.createElement('p'); ce.className = 'err'; ce.id = 'd-cover-err'; ce.style.display = 'none'; cw.appendChild(ce);
  body.appendChild(cw); setCoverPreview(pv);

  var rights = checkRow('d-rights', state.details.rightsConfirmed === true, 'I am the owner of the property, or I have permission from the owner of this property to create and share this tour of the property.', ''); // TWEAKS3: declaration comes before the visibility choice
  var pub = checkRow('d-public', state.details.unlisted === true, 'Keep my tour private', 'By default your tour is listed on the Glow360 homepage and sitemap so people can find it. Tick this box to keep it private instead: it still gets its own link to share, but is not listed.'); // TWEAKS2

  var kv = document.createElement('div'); kv.className = 'kv';
  (function () { var p = G.priceFor(state.scenes.length); return [['Scenes', p.scenes + ' × ' + G.fmtMoney(p.unit)], ['Subtotal', G.fmtMoney(p.subtotal)], ['GST (15%)', G.fmtMoney(p.gst)], ['Total (incl. GST)', G.fmtMoney(p.total)]]; })().forEach(function (r) {
    var a = document.createElement('span'); a.textContent = r[0]; var b = document.createElement('b'); b.textContent = r[1]; kv.appendChild(a); kv.appendChild(b);
  });
  body.appendChild(kv);
  var un = unlinkedScenes();
  if (un.length) { var w = document.createElement('p'); w.className = 'muted wn'; w.textContent = 'Not reachable by clicking through: ' + un.map(function (x) { return x.name; }).join(', ') + '. Visitors can still open them from “Explore Spaces”.'; body.appendChild(w); }
  function show(id, msg) { var e = $(id); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }

  nameIn.addEventListener('input', function () { state.details.clientName = nameIn.value; show('d-name-err', ''); });
  emailIn.addEventListener('input', function () { state.details.clientEmail = emailIn.value; show('d-email-err', ''); });
  addr.addEventListener('input', function () { state.details.address = addr.value; show('d-addr-err', ''); updateTitle(); });
  url.addEventListener('input', function () { state.details.url = url.value; show('d-url-err', ''); });
  pub.addEventListener('change', function () { state.details.unlisted = pub.checked; });
  rights.addEventListener('change', function () { state.details.rightsConfirmed = rights.checked; show('d-rights-err', ''); });
  pick.addEventListener('click', function () { fi.click(); });
  rm.addEventListener('click', function () { state.cover = null; setCoverPreview(pv); pick.textContent = 'Choose image'; rm.style.display = 'none'; show('d-cover-err', ''); persistCover(null); });
  fi.addEventListener('change', async function () {
    var f = fi.files && fi.files[0]; fi.value = ''; if (!f) return;
    pick.disabled = true; show('d-cover-err', ''); ch.textContent = 'Preparing image…';
    var r = await processCover(f);
    pick.disabled = false; ch.textContent = 'Shown when your link is shared (WhatsApp, Facebook, iMessage…). A wide landscape photo works best: at least ' + COVER.minW + '×' + COVER.minH + ', shaped between 4:3 and 2.4:1.';
    if (!r.ok) { show('d-cover-err', r.error); return; }
    state.cover = r.blob; setCoverPreview(pv); pick.textContent = 'Change image'; rm.style.display = ''; persistCover(r.blob);
  });

  var go = $('modal-go'); go.style.display = ''; go.textContent = 'Continue';
  go.onclick = function () {
    var nm = checkName(nameIn.value), em = checkEmail(emailIn.value);
    var a = G.validateAddress(addr.value), u = G.normalizeListingUrl(url.value);
    show('d-name-err', nm.ok ? '' : nm.error); show('d-email-err', em.ok ? '' : em.error);
    show('d-addr-err', a.ok ? '' : a.error); show('d-url-err', u.ok ? '' : u.error);
    show('d-cover-err', state.cover ? '' : 'Please add a cover image.');
    show('d-rights-err', rights.checked ? '' : 'Please confirm this to continue.');
    var firstBad = !nm.ok ? nameIn : !em.ok ? emailIn : !a.ok ? addr : !u.ok ? url : !state.cover ? pick : !rights.checked ? rights : null;
    if (firstBad) { firstBad.focus(); return; }
    state.details.clientName = nm.value; state.details.clientEmail = em.value;
    state.details.address = a.value; state.details.url = u.value; state.details.unlisted = pub.checked; state.details.rightsConfirmed = true; updateTitle();
    body.textContent = ''; $('modal-t').textContent = 'Review and publish';
    var k = document.createElement('div'); k.className = 'kv';
    [['Name', nm.value], ['Email', em.value], ['Title', a.value], ['Description', 'A self guided tour of ' + a.value], ['Total', G.fmtMoney(G.priceFor(state.scenes.length).total) + ' incl. GST'], ['Tour link', G360Api.toursBase.replace(/^https?:\/\//, '') + '/client-###-' + G.slugify(a.value) + '/'], ['Listing link', u.value || 'None'], ['Visibility', state.details.unlisted ? 'Private link (not listed)' : 'Listed publicly'], ['Autorotate', 'On']].forEach(function (r) {
      var x = document.createElement('span'); x.textContent = r[0]; var y = document.createElement('b'); y.textContent = r[1]; y.style.wordBreak = 'break-word'; y.style.textAlign = 'right'; k.appendChild(x); k.appendChild(y);
    });
    body.appendChild(k);
    var n = document.createElement('p'); n.className = 'muted'; n.textContent = 'Publishing uploads your photos securely and makes your tour live. Large tours can take a few minutes, so keep this tab open until it finishes.'; body.appendChild(n);
    if (a.warn) { var w2 = document.createElement('p'); w2.className = 'muted wn'; w2.textContent = a.warn; body.appendChild(w2); }
    go.style.display = ''; go.textContent = 'Publish tour'; go.onclick = function () { runPublish(); };
  };
  $('modal').style.display = 'flex'; setTimeout(function () { nameIn.focus(); }, 30);
}

/* ---------- persistence (G360Draft) ---------- */
// The editor saves itself to IndexedDB so a reload, crash or Stripe round trip can't lose a tour.
//  - A scene is saved the moment it finishes tiling (the slow work worth protecting): its metadata and
//    every tile blob commit atomically (G360Draft.saveScene).
//  - Everything else (rename, hotspots, start view, reorder, delete, address/link) is found by a
//    1-second dirty check against what was last written, so no individual edit needs its own hook.
//  - All writes go through one queue, so they can never overlap or reorder.
//  - The draft id made here is the SAME uuid the order API takes as draftId (piece 6); that is what
//    makes create-order's idempotency work across reloads.
//  - A failed save never blocks editing: the tour keeps working in memory and the header says
//    "Not saved: ..." so the customer knows a reload would lose it.
//  - One browser tab per draft: two tabs editing the same draft would overwrite each other.
var D = G360Draft;
var persist = { id: null, ready: false, pending: 0, failed: '', saved: new Map(), metaJson: '', everSaved: false, asked: false };
var chain = Promise.resolve();

function setSaveStat() {
  var el = $('savestat'); if (!el) return;
  if (persist.failed) { el.textContent = persist.failed; el.className = 'muted no'; }
  else if (persist.pending) { el.textContent = 'Saving…'; el.className = 'muted'; }
  else if (persist.everSaved) { el.textContent = 'Draft saved'; el.className = 'muted'; }
  else { el.textContent = ''; el.className = 'muted'; }
}

function onPersistError(e) {
  console.error('draft save failed', e);
  persist.failed = D.isQuotaError(e) ? 'Not saved: browser storage is full'
    : 'Not saved: ' + ((e && e.message) || 'storage error');
}

function enqueue(fn) {
  persist.pending++; setSaveStat();
  var p = chain.then(fn).catch(onPersistError).then(function () { persist.pending--; setSaveStat(); });
  chain = p;
  return p;
}
function persistIdle() { return chain; }

function currentSceneId() { var c = curScene(); return c ? c.id : null; }

// The editable part of a scene: what the dirty check watches and updateScene writes. Untitled info
// points are left out, matching the editor, which discards them when deselected.
function metaRecord(s) {
  return {
    name: s.name,
    start: { yaw: s.start.yaw, pitch: s.start.pitch, fov: s.start.fov },
    links: s.links.map(function (l) { return { yaw: l.yaw, pitch: l.pitch, target: l.target }; }),
    infos: s.infos.filter(function (n) { return String(n.title || '').trim(); })
      .map(function (n) { return { yaw: n.yaw, pitch: n.pitch, title: n.title, text: n.text || '' }; })
  };
}
function metaSnap(orderIds) {
  return { sceneOrder: orderIds, curId: currentSceneId(), details: Object.assign({}, state.details) };
}

// Save a freshly tiled scene: its record and every tile blob (plus a thumbnail) in one transaction.
// The 6 fallback faces are not stored: they are rebuilt from preview.jpg on restore.
function persistNewScene(s) {
  return enqueue(async function () {
    if (state.scenes.indexOf(s) < 0) return; // deleted while waiting its turn
    if (!persist.id) persist.id = await D.startNew();
    var blobs = new Map(s.tiles);
    blobs.set(D.thumbKey(s.id), await toBlob(s.thumb, 'image/jpeg', 0.8));
    var order = state.scenes.map(function (x) { return x.id; })
      .filter(function (id) { return id === s.id || persist.saved.has(id); });
    var snap = metaSnap(order), rec = metaRecord(s);
    await D.saveScene(persist.id,
      Object.assign({ id: s.id, faceSize: s.faceSize, srcWidth: s.srcWidth, capped: s.capped, levels: s.levels, bytes: s.bytes, files: s.files }, rec),
      blobs, snap);
    persist.saved.set(s.id, JSON.stringify(rec));
    persist.metaJson = JSON.stringify(snap);
    persist.everSaved = true;
    if (!persist.asked) { persist.asked = true; D.requestPersistence(); } // best effort: ask the browser not to evict us
  });
}

// What differs between the editor and what was last written. Returns null when nothing does.
function computeWork() {
  if (!persist.id) return null;
  var ids = state.scenes.map(function (s) { return s.id; });
  var w = { deletes: [], updates: [], meta: null };
  persist.saved.forEach(function (json, id) { if (ids.indexOf(id) < 0) w.deletes.push(id); });
  state.scenes.forEach(function (s) {
    if (!persist.saved.has(s.id)) return; // not saved yet: persistNewScene owns it
    var rec = metaRecord(s), json = JSON.stringify(rec);
    if (json !== persist.saved.get(s.id)) w.updates.push({ id: s.id, rec: rec, json: json });
  });
  var snap = metaSnap(ids.filter(function (id) { return persist.saved.has(id); }));
  var mj = JSON.stringify(snap);
  if (mj !== persist.metaJson) w.meta = { snap: snap, json: mj };
  return (w.deletes.length || w.updates.length || w.meta) ? w : null;
}

async function runWork(w) {
  var i;
  for (i = 0; i < w.deletes.length; i++) { await D.deleteScene(persist.id, w.deletes[i], {}); persist.saved.delete(w.deletes[i]); }
  for (i = 0; i < w.updates.length; i++) { await D.updateScene(persist.id, w.updates[i].id, w.updates[i].rec); persist.saved.set(w.updates[i].id, w.updates[i].json); }
  if (w.meta) { await D.saveMeta(persist.id, w.meta.snap); persist.metaJson = w.meta.json; }
  persist.everSaved = true;
}

function flushSoon() {
  if (!persist.ready || persist.pending) return;
  var w = computeWork();
  if (!w) {
    // Nothing left to write. Clear an old failure once every scene is safely stored.
    var unsaved = state.scenes.some(function (s) { return !persist.saved.has(s.id); });
    if (persist.failed && !unsaved) { persist.failed = ''; setSaveStat(); }
    return;
  }
  enqueue(function () { return runWork(w); });
}

async function sceneFromRecord(rec) {
  if (!rec.levels || !rec.start || !rec.links || !rec.infos) throw new Error('incomplete scene record');
  var tiles = new Map(), thumbBlob = null, tkey = D.thumbKey(rec.id);
  rec.blobs.forEach(function (blob, k) { if (k === tkey) thumbBlob = blob; else tiles.set(k, blob); });
  var previewBlob = tiles.get(rec.id + '/preview.jpg');
  if (!previewBlob) throw new Error('preview strip missing');
  var thumb = mkCanvas(192, 96);
  if (thumbBlob) {
    var tb = await createImageBitmap(thumbBlob);
    thumb.getContext('2d').drawImage(tb, 0, 0, 192, 96);
    try { tb.close(); } catch (e) {}
  }
  // The 256px fallback faces are the six slices of the preview strip, in G.PREVIEW_ORDER.
  var strip = await createImageBitmap(previewBlob), fallback = {};
  for (var i = 0; i < 6; i++) {
    var c = mkCanvas(256, 256);
    c.getContext('2d').drawImage(strip, 0, i * 256, 256, 256, 0, 0, 256, 256);
    fallback[G.PREVIEW_ORDER[i]] = c;
  }
  try { strip.close(); } catch (e) {}
  return {
    id: rec.id, thumb: thumb, name: rec.name, faceSize: rec.faceSize, srcWidth: rec.srcWidth, capped: rec.capped,
    levels: rec.levels, tiles: tiles, fallback: fallback, bytes: rec.bytes, files: rec.files,
    start: { yaw: rec.start.yaw, pitch: rec.start.pitch, fov: rec.start.fov },
    links: rec.links.map(function (l) { return { yaw: l.yaw, pitch: l.pitch, target: l.target }; }),
    infos: rec.infos.map(function (n) { return { yaw: n.yaw, pitch: n.pitch, title: n.title, text: n.text || '' }; }),
    mz: null
  };
}

async function rebuildFrom(loaded) {
  persist.id = loaded.meta.draftId;
  var det = loaded.meta.details || {};
  state.details.clientName = det.clientName || '';
  state.details.clientEmail = det.clientEmail || '';
  state.details.address = det.address || '';
  state.details.url = det.url || '';
  state.details.unlisted = det.unlisted === true;             // listed unless the customer chose private
  state.details.rightsConfirmed = det.rightsConfirmed === true;
  state.cover = loaded.cover || null;
  state.orderLocked = !!loaded.meta.orderId; // PIECE6
  updateTitle();
  if (!loaded.scenes.length) { persist.metaJson = JSON.stringify(metaSnap([])); return; }
  if (!ensureViewer()) return;
  state.busy = true; setBusy();
  var skipped = [], restored = [], maxUid = -1;
  try {
    for (var i = 0; i < loaded.scenes.length; i++) {
      var rec = loaded.scenes[i];
      setProgress('Restoring your draft… (' + (i + 1) + '/' + loaded.scenes.length + ')', i / loaded.scenes.length);
      try { restored.push(await sceneFromRecord(rec)); }
      catch (e) { console.warn('skipping unreadable scene', rec.id, e); skipped.push(rec.id); }
    }
    var okIds = {};
    restored.forEach(function (s) { okIds[s.id] = true; });
    // A link to a scene that could not be restored would fail server-side validation at publish.
    restored.forEach(function (s) { s.links = s.links.filter(function (l) { return okIds[l.target]; }); });
    // Every scene must be in state.scenes BEFORE any is built: a link hotspot is only drawn if its target exists.
    restored.forEach(function (s) { state.scenes.push(s); });
    restored.forEach(function (s) {
      buildMz(s);
      persist.saved.set(s.id, JSON.stringify(metaRecord(s)));
      var u = parseInt(s.id, 10); if (u > maxUid) maxUid = u;
    });
  } finally { state.busy = false; setBusy(); setProgress(''); }
  state.nextId = Math.max(state.nextId, maxUid + 1); // new scene ids must not collide with restored ones
  if (state.scenes.length) {
    var idx = state.scenes.map(function (s) { return s.id; }).indexOf(loaded.meta.curId);
    showScene(idx < 0 ? 0 : idx, true);
    toast('Restored your draft (' + state.scenes.length + (state.scenes.length === 1 ? ' scene' : ' scenes') + ')');
  }
  persist.metaJson = JSON.stringify(metaSnap(state.scenes.map(function (s) { return s.id; })));
  persist.everSaved = true;
  skipped.forEach(function (id) { enqueue(function () { return D.deleteScene(persist.id, id, {}); }); });
}

async function restoreDraft() {
  try {
    var id = await D.getCurrentDraftId();
    var loaded = id ? await D.load(id) : null;
    if (loaded) await rebuildFrom(loaded);
  } catch (e) {
    console.error('could not restore draft', e);
    showErr('Could not restore your saved draft: ' + ((e && e.message) || e));
    state.busy = false; setBusy(); setProgress('');
  }
  persist.ready = true;
  setSaveStat();
}

setInterval(flushSoon, 1000);
document.addEventListener('visibilitychange', function () { if (document.hidden) flushSoon(); });
window.addEventListener('pagehide', flushSoon);
/* ---------- end persistence ---------- */

/* ---------- wiring ---------- */
$('tt-scene').addEventListener('click', function () {
  var s = curScene(); if (!s) return; var btn = $('tt-scene');
  var inp = document.createElement('input'); inp.type = 'text'; inp.className = 'scn-input'; inp.value = s.name; inp.maxLength = 60; inp.setAttribute('aria-label', 'Scene name');
  btn.style.display = 'none'; btn.parentNode.insertBefore(inp, btn.nextSibling); inp.focus(); inp.select();
  function done(commit) {
    if (!inp.parentNode) return; var v = clean(inp.value, 60); inp.remove(); btn.style.display = '';
    if (commit && v && v !== s.name) { s.name = v; renderScenes(); state.scenes.forEach(renderHotspots); }
    updateTitle();
  }
  inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
  inp.addEventListener('blur', function () { done(true); });
});
$('add').addEventListener('click', function () { $('file').click(); });
$('empty-add').addEventListener('click', function () { $('file').click(); });
$('file').addEventListener('change', function (e) { var f = Array.prototype.slice.call(e.target.files); e.target.value = ''; addFiles(f); });
$('empty-demo').addEventListener('click', async function () { addFiles([await demoFile(0), await demoFile(1)]); });

$('b-link').addEventListener('click', addLink);
$('b-info').addEventListener('click', addInfo);
$('b-start').addEventListener('click', function () {
  var s = curScene(); if (!s || !s.mz) return toast('Add a scene first');
  var v = s.mz.view; s.start = { yaw: v.yaw(), pitch: v.pitch(), fov: v.fov() }; syncPublish(); toast('Initial view saved');
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if ($('modal').style.display === 'flex') $('modal').style.display = 'none'; else clearSel(); } });

// tap (not drag) on the panorama places hotspots
var down = null; var panoEl = $('pano');
panoEl.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY, t: Date.now(), hs: !!(e.target.closest && e.target.closest('.hs')) }; });
panoEl.addEventListener('pointerup', function (e) {
  if (!down || down.hs) { down = null; return; }
  var moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = Date.now() - down.t; down = null;
  if (moved < 8 && dt < 600) onPanoTap();
});

function applyLayout() {
  if (viewer) viewer.updateSize();
  var s = curScene(); if (s && s.mz) s.mz.view.setFov(fixedFov());   // re-fit the locked view after a resize / rotation
}
var lastPortrait = null;
window.addEventListener('resize', function () {
  var z = stageSize(), p = z.w < z.h;
  if (p !== lastPortrait) { lastPortrait = p; applyLayout(); }
});

$('publish').addEventListener('click', openPublish);
$('modal-x').addEventListener('click', function () { $('modal').style.display = 'none'; });
window.addEventListener('beforeunload', function (e) { if (state.scenes.length && !paymentRedirect) { e.preventDefault(); e.returnValue = ''; } });

renderScenes(); syncPublish(); lastPortrait = stageSize().w < stageSize().h;
restoreDraft().then(handlePaymentReturn);
})();
