/* ===== worker.js : runs INSIDE the tiling Web Worker (piece 5). =====
 * build.js embeds core.js + this file in the page (#g360-worker-src) and app.js starts them as a Worker
 * from an inline Blob, so create-tour.html stays one file. core.js comes first, so G360 is defined here.
 *
 * This mirrors tileScene() in app.js step for step, using OffscreenCanvas instead of DOM canvases, so
 * decoding, the six cube faces, the downscale ladder and the JPEG encodes never block the page.
 * It posts back plain data only (blobs + numbers). The page turns that into a scene with
 * sceneFromRecord(), the same function a restored draft goes through.
 *
 * Messages in : { type: 'tile', file, cap, uid, label }
 * Messages out: { type: 'progress', text, frac } ... then { type: 'done', result } or
 *               { type: 'error', kind, message }
 *   kind 'user'        -> the photo itself is unusable (wrong shape / too small): show the message
 *   kind 'unsupported' -> this browser's worker lacks OffscreenCanvas: page falls back to the main thread
 *   kind 'failed'      -> anything else: page retries this one scene on the main thread
 */
var G = G360;

function post(m) { self.postMessage(m); }
function fail(kind, msg) { var e = new Error(msg); e.kind = kind; return e; }
function mk(w, h) { return new OffscreenCanvas(w, h); }
function toJpeg(c, q) { return c.convertToBlob({ type: 'image/jpeg', quality: q }); }

async function tileOne(file, cap, uid, label) {
  var bmp = await createImageBitmap(file);
  var origW = bmp.width, origH = bmp.height, ratio = origW / origH;
  if (Math.abs(ratio - 2) > 0.03) {
    bmp.close();
    throw fail('user', '"' + (file.name || 'image') + '" is ' + origW + '×' + origH + '. Needs a 2:1 equirectangular panorama.');
  }
  if (origW < 2048) {
    bmp.close();
    throw fail('user', 'Image is too small (' + origW + ' px wide). Use at least 2048 px.');
  }
  var F = G.pickFaceSize(origW, cap);
  var W = Math.min(origW, 4 * F), H = Math.round(W / 2);
  post({ type: 'progress', text: label + 'reading image…', frac: 0 });
  var sc = mk(W, H), sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  var src = sctx.getImageData(0, 0, W, H).data;
  var thumb = mk(192, 96);
  thumb.getContext('2d').drawImage(sc, 0, 0, 192, 96);
  sc.width = 0;
  var thumbBlob = await toJpeg(thumb, 0.8);
  thumb.width = 0;

  var levels = G.buildLevels(F), sizes = levels.map(function (l) { return l.size; });
  var id = uid + '-' + G.slugify((file.name || 'scene').replace(/\.[^.]+$/, ''));
  var tiles = new Map(), fallbackCanvases = {}, bytes = 0, files = 0, CH = 48;

  for (var fi = 0; fi < G.FACES.length; fi++) {
    var face = G.FACES[fi];
    var fc = mk(F, F), fctx = fc.getContext('2d'), img = fctx.createImageData(F, F);
    for (var r = 0; r < F; r += CH) {
      G.renderFaceRows(src, W, H, face, F, r, Math.min(F, r + CH), img.data);
      post({ type: 'progress', text: label + 'face ' + (fi + 1) + '/6', frac: (fi + r / F) / 6 * 0.85 });
    }
    fctx.putImageData(img, 0, 0);
    // downscale ladder (halving keeps quality)
    var ladder = {}; ladder[F] = fc; var prev = fc;
    for (var s = F / 2; s >= 256; s /= 2) {
      var c2 = mk(s, s), x2 = c2.getContext('2d');
      x2.imageSmoothingQuality = 'high';
      x2.drawImage(prev, 0, 0, s, s);
      ladder[s] = c2; prev = c2;
    }
    fallbackCanvases[face] = ladder[256];
    for (var z = 1; z < levels.length; z++) {
      var size = sizes[z], n = size / 512, lc = ladder[size];
      for (var ty = 0; ty < n; ty++) for (var tx = 0; tx < n; tx++) {
        var tc = mk(512, 512);
        tc.getContext('2d').drawImage(lc, tx * 512, ty * 512, 512, 512, 0, 0, 512, 512);
        var blob = await toJpeg(tc, 0.85);
        tc.width = 0;
        tiles.set(G.tileKey(id, z, face, ty, tx), blob); bytes += blob.size; files++;
      }
    }
    Object.keys(ladder).forEach(function (k) { if (ladder[k] !== ladder[256]) ladder[k].width = 0; });
  }
  post({ type: 'progress', text: label + 'building preview…', frac: 0.92 });
  var pc = mk(256, 256 * 6), pctx = pc.getContext('2d');
  for (var i = 0; i < 6; i++) pctx.drawImage(fallbackCanvases[G.PREVIEW_ORDER[i]], 0, i * 256);
  var previewBlob = await toJpeg(pc, 0.85);
  pc.width = 0;
  tiles.set(id + '/preview.jpg', previewBlob); bytes += previewBlob.size; files++;

  return { id: id, thumbBlob: thumbBlob, faceSize: F, srcWidth: origW, capped: F < cap, levels: levels, tiles: tiles, bytes: bytes, files: files };
}

self.onmessage = async function (ev) {
  var m = ev.data;
  if (!m || m.type !== 'tile') return;
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof OffscreenCanvas.prototype.convertToBlob !== 'function' || typeof createImageBitmap !== 'function') {
      throw fail('unsupported', 'OffscreenCanvas is not available in workers in this browser');
    }
    var result = await tileOne(m.file, m.cap, m.uid, m.label || '');
    post({ type: 'done', result: result });
  } catch (e) {
    post({ type: 'error', kind: (e && e.kind) || 'failed', message: (e && e.message) || String(e) });
  }
};
