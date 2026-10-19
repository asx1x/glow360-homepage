/* ===== core.js : pure functions (no DOM) — tested in Node against Marzipano's own geometry ===== */
var G360 = (function () {
  var FACE_ROT = {
    f: { x: 0, y: 0 }, b: { x: 0, y: Math.PI }, l: { x: 0, y: Math.PI / 2 },
    r: { x: 0, y: -Math.PI / 2 }, u: { x: Math.PI / 2, y: 0 }, d: { x: -Math.PI / 2, y: 0 }
  };
  var FACES = ['f', 'b', 'l', 'r', 'u', 'd'];
  // Preview strip order. Matches Marzipano ImageUrlSource default ('bdflru').
  var PREVIEW_ORDER = 'bdflru';

  // World direction for point (a,b) on a face; a = right (-.5...5), b = up (-.5...5).
  // Mirrors Marzipano CubeTile.vertices(): (a,b,-0.5) rotated X then Y (gl-matrix conventions).
  function faceDir(face, a, b, out) {
    var r = FACE_ROT[face], cx = Math.cos(r.x), sx = Math.sin(r.x), cy = Math.cos(r.y), sy = Math.sin(r.y);
    var x = a, y = b, z = -0.5;
    var y1 = y * cx - z * sx, z1 = y * sx + z * cx;           // rotateX
    var x2 = z1 * sy + x * cy, z2 = z1 * cy - x * sy;         // rotateY
    out[0] = x2; out[1] = y1; out[2] = z2;
    return out;
  }

  // Equirect lookup coordinates (0..1) for a world direction.
  // Image centre = yaw 0 (front), right = +yaw, top = up.
  function dirToUV(x, y, z, out) {
    var len = Math.sqrt(x * x + y * y + z * z);
    var yaw = Math.atan2(x, -z);
    var lat = Math.asin(y / len);
    out[0] = 0.5 + yaw / (2 * Math.PI);
    out[1] = 0.5 - lat / Math.PI;
    return out;
  }

  // Marzipano view angles for a world direction (pitch: positive = DOWN in Marzipano).
  function dirToYawPitch(x, y, z) {
    var len = Math.sqrt(x * x + y * y + z * z);
    return { yaw: Math.atan2(x, -z), pitch: -Math.asin(y / len) };
  }

  // Bilinear sample (RGBA) from equirect pixel array; wraps horizontally, clamps vertically.
  function sample(src, W, H, u, v, out) {
    var fx = u * W - 0.5, fy = v * H - 0.5;
    var x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    var y1 = y0 + 1; if (y0 < 0) y0 = 0; if (y1 < 0) y1 = 0; if (y0 > H - 1) y0 = H - 1; if (y1 > H - 1) y1 = H - 1;
    var xa = ((x0 % W) + W) % W, xb = (((x0 + 1) % W) + W) % W;
    var i00 = (y0 * W + xa) * 4, i10 = (y0 * W + xb) * 4, i01 = (y1 * W + xa) * 4, i11 = (y1 * W + xb) * 4;
    for (var c = 0; c < 3; c++) {
      var top = src[i00 + c] * (1 - tx) + src[i10 + c] * tx;
      var bot = src[i01 + c] * (1 - tx) + src[i11 + c] * tx;
      out[c] = top * (1 - ty) + bot * ty;
    }
  }

  // Fill rows [r0, r1) of an F×F face into `dst` (RGBA Uint8ClampedArray, F*F*4).
  function renderFaceRows(src, W, H, face, F, r0, r1, dst) {
    var d = [0, 0, 0], uv = [0, 0], px = [0, 0, 0];
    for (var py = r0; py < r1; py++) {
      var b = 0.5 - (py + 0.5) / F;
      for (var pxi = 0; pxi < F; pxi++) {
        var a = (pxi + 0.5) / F - 0.5;
        faceDir(face, a, b, d);
        dirToUV(d[0], d[1], d[2], uv);
        sample(src, W, H, uv[0], uv[1], px);
        var o = (py * F + pxi) * 4;
        dst[o] = px[0]; dst[o + 1] = px[1]; dst[o + 2] = px[2]; dst[o + 3] = 255;
      }
    }
  }

  // Same level list shape the Marzipano Tool exports.
  function buildLevels(faceSize) {
    var levels = [{ tileSize: 256, size: 256, fallbackOnly: true }];
    for (var s = 512; s <= faceSize; s *= 2) levels.push({ tileSize: 512, size: s });
    return levels;
  }

  // Largest power of two <= min(cap, srcWidth/4), min 512.
  function pickFaceSize(srcWidth, cap) {
    var target = Math.min(cap, Math.floor(srcWidth / 4)), s = 512;
    while (s * 2 <= target) s *= 2;
    return s;
  }

  // Aspect-aware vertical FOV: keep a minimum horizontal FOV on tall (portrait) screens.
  // Marzipano's `fov` is the VERTICAL fov, so a fixed value gives a narrow slice in portrait.
  function aspectFov(width, height, baseVfov, minHfov, maxVfov) {
    var aspect = width / height;
    var hfov = 2 * Math.atan(Math.tan(baseVfov / 2) * aspect);
    if (hfov >= minHfov) return baseVfov;
    var v = 2 * Math.atan(Math.tan(minHfov / 2) / aspect);
    return Math.min(v, maxVfov);
  }

  // Live engine path: <slug>/app-files/<sceneId>/<z>/<f>/<y>/<x>.jpg  (no 'tiles/' folder)
  function tileKey(sceneId, z, f, y, x) { return sceneId + '/' + z + '/' + f + '/' + y + '/' + x + '.jpg'; }

  // Escape for HTML text / attribute contexts.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Serialise data.js safely: JSON, with characters that can break out of <script> escaped.
  function serializeData(data) {
    var json = JSON.stringify(data, null, 2)
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return 'window.APP_DATA = ' + json + ';\n';
  }


  // Listing link: optional. Accepts "trademe.co.nz/x" (adds https://), rejects javascript:, data:, credentials, spaces.
  function normalizeListingUrl(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return { ok: true, value: '' };
    if (s.length > 500) return { ok: false, error: 'That link is too long.' };
    if (/\s/.test(s)) return { ok: false, error: 'The link contains spaces. Paste it again from the listing page.' };
    if (!/^[a-z][a-z0-9+.\-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    var u;
    try { u = new URL(s); } catch (e) { return { ok: false, error: 'That does not look like a valid link.' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'The link must start with https:// or http://' };
    if (u.username || u.password) return { ok: false, error: 'The link must not contain a username or password.' };
    if (u.hostname.indexOf('.') < 1) return { ok: false, error: 'That does not look like a valid website address.' };
    return { ok: true, value: u.href };
  }

  // Property address = tour title. Plain text, 5-120 chars.
  function validateAddress(input) {
    var v = String(input == null ? '' : input).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!v) return { ok: false, error: 'Enter the property address.' };
    if (v.length < 5) return { ok: false, error: 'That address looks too short.' };
    if (v.length > 120) return { ok: false, error: 'Please keep the address under 120 characters.' };
    if (!/[a-z]/i.test(v)) return { ok: false, error: 'The address should include a street name.' };
    return { ok: true, value: v, warn: /\d/.test(v) ? '' : 'Tip: include the street number.' };
  }

  // Camera filenames (IMG_20260915_165304_00_merged) make poor scene names.
  function defaultSceneName(fileName, n) {
    var base = String(fileName || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    if (!base || /\d{6,}/.test(base) || /merged|stitched/i.test(base)) return 'Scene ' + n;
    return base.slice(0, 60);
  }

  // Pricing: $10 + GST per scene (image). 1 to 15 scenes. Amounts are integer cents; NZ GST 15% (confirm with accountant).
  var PRICING = { perSceneCents: 1000, gstRate: 0.15, minScenes: 1, maxScenes: 15, currency: 'NZD' };
  function priceFor(n) {
    n = Math.floor(Number(n));
    var subtotal = n * PRICING.perSceneCents, gst = Math.round(subtotal * PRICING.gstRate);
    return { scenes: n, unit: PRICING.perSceneCents, subtotal: subtotal, gst: gst, total: subtotal + gst };
  }
  function validateSceneCount(n) {
    n = Number(n);
    if (!isFinite(n) || n < PRICING.minScenes) return { ok: false, error: 'Add at least ' + PRICING.minScenes + ' scene.' };
    if (n > PRICING.maxScenes) return { ok: false, error: 'A tour can have at most ' + PRICING.maxScenes + ' scenes.' };
    return { ok: true };
  }
  function fmtMoney(cents) { return '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0); }

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'scene';
  }

  return { FACES: FACES, FACE_ROT: FACE_ROT, PREVIEW_ORDER: PREVIEW_ORDER, faceDir: faceDir, dirToUV: dirToUV,
    dirToYawPitch: dirToYawPitch, sample: sample, renderFaceRows: renderFaceRows, buildLevels: buildLevels,
    pickFaceSize: pickFaceSize, aspectFov: aspectFov, tileKey: tileKey, PRICING: PRICING, priceFor: priceFor, validateSceneCount: validateSceneCount, fmtMoney: fmtMoney, normalizeListingUrl: normalizeListingUrl, validateAddress: validateAddress, defaultSceneName: defaultSceneName, esc: esc, serializeData: serializeData, slugify: slugify };
})();
if (typeof module !== 'undefined') module.exports = G360;
