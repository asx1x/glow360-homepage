/* ===== api.js : talks to the real Edge Functions (create-order, upload-urls, finalize). =====
 * Pure-ish module: no DOM access, every function takes explicit args and returns a plain result
 * object ({ ok: true, ... } | { ok: false, error: string }) rather than throwing, so the UI layer
 * can render failures directly without a try/catch around every call site.
 *
 * Which backend this talks to is decided by the HOSTNAME the page is served from (see ENVIRONMENTS below), so the
 * same build is correct everywhere and there is no launch-day constant to forget to change.
 */
var G360Api = (function () {
  // Only the real site's hostnames use production. EVERYTHING else (localhost, staging.glow360.co.nz, a Vercel preview, a
  // file:// page, a look-alike domain) uses STAGING, so a mistake can only ever point at staging, never at live customer data.
  // toursBase must match the publish function's TOURS_DOMAIN for that environment. No trailing slashes.
  var ENVIRONMENTS = {
    production: { supabaseUrl: 'https://caaenhofcnxbhiskqrzk.supabase.co', toursBase: 'https://tours.glow360.co.nz' },
    staging: { supabaseUrl: 'https://ogkcbmcboryqphwnvgls.supabase.co', toursBase: 'https://tours-staging.glow360.co.nz' }
  };
  var PRODUCTION_HOSTS = ['glow360.co.nz', 'www.glow360.co.nz'];
  function pickEnvironment(hostname) {
    return PRODUCTION_HOSTS.indexOf(String(hostname || '').toLowerCase()) >= 0 ? 'production' : 'staging';
  }
  var ENV_NAME = pickEnvironment(typeof location !== 'undefined' ? location.hostname : '');
  var SUPABASE_URL = ENVIRONMENTS[ENV_NAME].supabaseUrl;
  var FN = SUPABASE_URL + '/functions/v1';
  var TOURS_BASE = ENVIRONMENTS[ENV_NAME].toursBase;

  // Local storage key for the resume token -- see Part 2 (IndexedDB draft persistence) for why
  // this ALSO needs to survive a full page reload / the Stripe return trip, not just live in
  // memory. This module itself is storage-agnostic: callers pass the token in, get it back out.
  async function postJson(url, body, authToken) {
    var headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    var res;
    try {
      res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    } catch (e) {
      return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
    }
    var json;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok) {
      var msg = (json && json.error) || ('Request failed (' + res.status + ')');
      return { ok: false, error: msg, status: res.status, fields: json && json.fields };
    }
    return { ok: true, status: res.status, body: json };
  }

  // POST /orders -- creates or resumes a draft. draftId must be a stable UUID the browser
  // generates ONCE per tour-in-progress and persists (IndexedDB) -- re-POSTing the same draftId
  // is how a page reload resumes cleanly rather than creating a duplicate order (see the backend's
  // own idempotent-on-draftId behavior, proven in create-order/handler.test.ts).
  async function createOrder(draftId, fields) {
    var res = await postJson(FN + '/create-order', {
      draftId: draftId,
      clientName: fields.clientName,
      clientEmail: fields.clientEmail,
      address: fields.address,
      listingUrl: fields.listingUrl || '',
      sceneCount: fields.sceneCount,
      returnTo: fields.returnTo,
    });
    return res;
  }

  // POST /orders/:id/upload-urls -- requires the resume token from createOrder's response.
  // `files` is [{ key, size }], same shape the backend expects verbatim.
  async function requestUploadUrls(orderId, resumeToken, files) {
    return postJson(FN + '/upload-urls/' + orderId + '/upload-urls', { files: files }, resumeToken);
  }

  // PUTs one file to its presigned R2 URL. Headers MUST match exactly what was signed
  // (Content-Type: image/jpeg, a fixed long-lived Cache-Control) -- see upload-urls/handler.ts.
  async function uploadToR2(url, blob, onProgress) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'image/jpeg');
      xhr.setRequestHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (onProgress) xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
      xhr.onload = function () { resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status }); };
      xhr.onerror = function () { resolve({ ok: false, status: 0 }); };
      xhr.send(blob);
    });
  }

  // POST /orders/:id/finalize -- tourData must already be in the server's validated shape
  // (scenes[].id/name/levels/faceSize/initialViewParameters/linkHotspots/infoHotspots), plus the
  // two Step 8.5 fields. rightsConfirmed MUST be the literal boolean true -- the server rejects
  // anything else, including a truthy string (see finalize/handler.test.ts).
  async function finalize(orderId, resumeToken, tourData, unlisted, rightsConfirmed) {
    return postJson(FN + '/finalize/' + orderId + '/finalize', {
      tourData: tourData,
      unlisted: unlisted,
      rightsConfirmed: rightsConfirmed,
    }, resumeToken);
  }

  // GET /orders/:id -- for polling publish status after finalize returns (finalize's own response
  // only confirms 'uploaded'; actual publish happens asynchronously -- see the handoff doc's note
  // on finalize awaiting triggerPublish internally, but the UI should still poll to catch a
  // 'failed' outcome rather than assume success).
  async function pollOrder(orderId, resumeToken) {
    var headers = { Authorization: 'Bearer ' + resumeToken };
    var res;
    try {
      res = await fetch(FN + '/get-order/' + orderId, { headers: headers });
    } catch (e) {
      return { ok: false, error: 'Could not reach the server.' };
    }
    var json;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok) return { ok: false, error: (json && json.error) || ('Request failed (' + res.status + ')'), status: res.status };
    return { ok: true, body: json };
  }

  return { createOrder: createOrder, requestUploadUrls: requestUploadUrls, uploadToR2: uploadToR2, finalize: finalize, pollOrder: pollOrder, toursBase: TOURS_BASE, environment: ENV_NAME, pickEnvironment: pickEnvironment };
})();
