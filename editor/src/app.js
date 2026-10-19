(function () {
'use strict';
var G = G360;
var $ = function (id) { return document.getElementById(id); };
var LIMITS = { scenes: G.PRICING.maxScenes, bytes: 200 * 1024 * 1024 };

var state = { scenes: [], cur: -1, pending: null, portrait: false, aspect: true, auto: true, busy: false, nextId: 0, sel: null, details: { address: '', url: '' } };
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

async function addFiles(files) {
  if (state.busy || !files.length) return;
  if (!ensureViewer()) return;
  if (state.scenes.length + files.length > LIMITS.scenes) { showErr('A tour can have at most ' + LIMITS.scenes + ' scenes (' + G.fmtMoney(G.priceFor(LIMITS.scenes).subtotal) + ' + GST).'); return; }
  showErr(''); state.busy = true; setBusy();
  var cap = 2048, added = 0;
  try {
    for (var i = 0; i < files.length; i++) {
      var s = await tileScene(files[i], i, files.length, cap, state.nextId++);
      state.scenes.push(s); buildMz(s); added++;
      if (state.cur < 0) showScene(state.scenes.length - 1, true); else { renderScenes(); syncPublish(); }
    }
    toast(added + (added === 1 ? ' scene' : ' scenes') + ' ready');
  } catch (e) { console.error(e); showErr(e.message || String(e)); }
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
function openPublish() {
  var body = $('modal-b'); body.textContent = ''; $('modal-t').textContent = 'Tour details';
  var t = totals();
  function field(labelText, id, value, ph, help) {
    var wrap = document.createElement('div'); wrap.style.marginBottom = '14px';
    var lab = document.createElement('label'); lab.className = 'modal-field'; lab.htmlFor = id; lab.textContent = labelText; wrap.appendChild(lab);
    var inp = document.createElement('input'); inp.type = 'text'; inp.id = id; inp.value = value; inp.placeholder = ph; inp.autocomplete = 'off'; wrap.appendChild(inp);
    var h = document.createElement('div'); h.className = 'muted fh'; h.textContent = help; wrap.appendChild(h);
    var e = document.createElement('p'); e.className = 'err'; e.id = id + '-err'; e.style.display = 'none'; wrap.appendChild(e);
    body.appendChild(wrap); return inp;
  }
  var addr = field('Property address (tour title)', 'd-addr', state.details.address, 'e.g. 12 Example Street, Remuera, Auckland', 'Shown at the top of your tour and in link previews.');
  var url = field('Listing link (optional)', 'd-url', state.details.url, 'https://www.trademe.co.nz/… or zillow.com/…', 'Adds an “Open Listing Page” button to your tour. Paste the link from your agent’s listing (Trade Me, Zillow, etc).');
  addr.maxLength = 120; url.maxLength = 500; url.setAttribute('inputmode', 'url');
  var kv = document.createElement('div'); kv.className = 'kv';
  (function () { var p = G.priceFor(state.scenes.length); return [['Scenes', p.scenes + ' × ' + G.fmtMoney(p.unit)], ['Subtotal', G.fmtMoney(p.subtotal)], ['GST (15%)', G.fmtMoney(p.gst)], ['Total (incl. GST)', G.fmtMoney(p.total)]]; })().forEach(function (r) {
    var a = document.createElement('span'); a.textContent = r[0]; var b = document.createElement('b'); b.textContent = r[1]; kv.appendChild(a); kv.appendChild(b);
  });
  body.appendChild(kv);
  var un = unlinkedScenes();
  if (un.length) { var w = document.createElement('p'); w.className = 'muted wn'; w.textContent = 'Not reachable by clicking through: ' + un.map(function (x) { return x.name; }).join(', ') + '. Visitors can still open them from “Explore Spaces”.'; body.appendChild(w); }
  function show(id, msg) { var e = $(id); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }
  addr.addEventListener('input', function () { state.details.address = addr.value; show('d-addr-err', ''); updateTitle(); });
  url.addEventListener('input', function () { state.details.url = url.value; show('d-url-err', ''); });
  var go = $('modal-go'); go.style.display = ''; go.textContent = 'Continue to payment';
  go.onclick = function () {
    var a = G.validateAddress(addr.value), u = G.normalizeListingUrl(url.value), ok = true;
    show('d-addr-err', a.ok ? '' : a.error); show('d-url-err', u.ok ? '' : u.error);
    if (!a.ok || !u.ok) { (a.ok ? url : addr).focus(); return; }
    state.details.address = a.value; state.details.url = u.value; updateTitle();
    body.textContent = ''; $('modal-t').textContent = 'Details saved'; go.style.display = 'none';
    var k = document.createElement('div'); k.className = 'kv';
    [['Title', a.value], ['Description', 'A self guided tour of ' + a.value], ['Total', G.fmtMoney(G.priceFor(state.scenes.length).total) + ' incl. GST'], ['Tour link', 'tours.glow360.co.nz/client-###-' + G.slugify(a.value) + '/'], ['Listing link', u.value || 'None'], ['Autorotate', 'On']].forEach(function (r) {
      var x = document.createElement('span'); x.textContent = r[0]; var y = document.createElement('b'); y.textContent = r[1]; y.style.wordBreak = 'break-word'; y.style.textAlign = 'right'; k.appendChild(x); k.appendChild(y);
    });
    body.appendChild(k);
    var n = document.createElement('p'); n.className = 'muted'; n.textContent = 'Prototype: payment and publishing are the next build phase (Stripe checkout, secure upload, automatic publish). Nothing has been uploaded or charged.'; body.appendChild(n);
    if (a.warn) { var w2 = document.createElement('p'); w2.className = 'muted wn'; w2.textContent = a.warn; body.appendChild(w2); }
  };
  $('modal').style.display = 'flex'; setTimeout(function () { addr.focus(); }, 30);
}

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
window.addEventListener('beforeunload', function (e) { if (state.scenes.length) { e.preventDefault(); e.returnValue = ''; } });

renderScenes(); syncPublish(); lastPortrait = stageSize().w < stageSize().h;
})();
