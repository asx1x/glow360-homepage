/* ===== draft.js : IndexedDB persistence for a tour-in-progress. =====
 * Why: building a tour is slow (client-side tiling produces up to ~80 MB of tiles) and the flow
 * leaves the page (Stripe checkout and back). A reload, crash or redirect must not lose it.
 *
 * What's stored (DB "glow360-tour-builder"):
 *   meta   : { key:'currentDraftId', value }         which draft the page should resume
 *   drafts : { draftId, orderId, slug, resumeToken, details{...}, sceneOrder[], cur, ... }
 *   scenes : { draftId, id, name, faceSize, levels, start, links, infos, ... }   one per scene
 *   blobs  : { draftId, key, blob }   tiles, preview strips, thumbnails, fallback faces, cover image
 * Blobs live in their own records (not inside the scene record) so one scene's ~130 tiles can be
 * written, replaced or deleted without cloning the whole tour, and so a scene is written atomically:
 * its record, all its blobs and the draft's scene order commit together or not at all.
 *
 * Limits worth knowing: browsers may evict this storage (Safari clears script-writable storage after
 * ~7 days without interaction with the site) and quota is finite -- see isQuotaError(). This protects
 * against reloads, crashes and the Stripe round trip, not against walking away for weeks.
 * The resume token is stored here; it is the bearer credential for the order (same trust model as the
 * server: whoever holds it can upload to and finalize that order).
 *
 * Callers pass plain data plus Blobs only -- no canvases, DOM nodes or functions (they can't be
 * structured-cloned). Convert canvases to Blobs first.
 */
var G360Draft = (function () {
  'use strict';

  var COVER_KEY = '__cover';
  function thumbKey(sceneId) { return sceneId + '/__thumb'; }
  function fallbackKey(sceneId, face) { return sceneId + '/__fb/' + face; }

  function blankDetails() {
    // unlisted defaults to true and rights to false: the customer must actively opt in to public
    // visibility and actively make the ownership declaration (see the main handoff, Step 8.5).
    return { clientName: '', clientEmail: '', address: '', url: '', unlisted: true, rightsConfirmed: false };
  }

  function isQuotaError(e) {
    return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
  }

  // Every record whose compound key starts with this draft id. Arrays sort after strings in
  // IndexedDB key order, so [draftId, []] is an upper bound for every [draftId, <string>].
  function draftRange(draftId) { return IDBKeyRange.bound([draftId], [draftId, []]); }
  // Every blob belonging to one scene: keys are always "<sceneId>/...", so a trailing-slash prefix
  // range can never catch a different scene whose id merely starts with the same letters.
  function sceneBlobRange(draftId, sceneId) {
    return IDBKeyRange.bound([draftId, sceneId + '/'], [draftId, sceneId + '/\uffff']);
  }

  // Read-modify-write of the draft record INSIDE an existing transaction. Callback style on purpose
  // (no awaits) so the transaction stays alive in every browser. `details` is deep-merged one level
  // so a patch of { details:{ address } } doesn't wipe the other fields.
  function mergeDraft(store, draftId, patch, fail) {
    var g = store.get(draftId);
    g.onsuccess = function () {
      var rec = g.result;
      if (!rec) { fail('draft not found: ' + draftId); return; }
      Object.keys(patch || {}).forEach(function (k) {
        if (k === 'details') rec.details = Object.assign({}, rec.details, patch.details);
        else if (k !== 'draftId') rec[k] = patch[k];
      });
      rec.updatedAt = Date.now();
      store.put(rec);
    };
  }

  function create(dbName) {
    var dbPromise = null;

    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('This browser cannot save drafts (IndexedDB unavailable).'));
          return;
        }
        var req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          db.createObjectStore('meta', { keyPath: 'key' });
          db.createObjectStore('drafts', { keyPath: 'draftId' });
          db.createObjectStore('scenes', { keyPath: ['draftId', 'id'] });
          db.createObjectStore('blobs', { keyPath: ['draftId', 'key'] });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () {
          reject(new Error('Draft storage is blocked by another open tab of this page. Close it and reload.'));
        };
      });
      dbPromise.catch(function () { dbPromise = null; }); // allow a retry after a failed open
      return dbPromise;
    }

    // Runs fn inside one transaction. fn(tx, fail, out): issue requests synchronously, put any result
    // in out.value, call fail(msg) to abort and roll everything back. Resolves with out.value once the
    // transaction has fully committed; rejects (with the original DOMException, so isQuotaError works)
    // if it aborts.
    function runTx(stores, mode, fn) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(stores, mode), failure = null, out = {};
          tx.oncomplete = function () { resolve(out.value); };
          tx.onabort = function () {
            reject(failure ? new Error(failure) : (tx.error || new Error('Transaction aborted')));
          };
          function fail(msg) { failure = msg; try { tx.abort(); } catch (e) {} }
          try { fn(tx, fail, out); } catch (e) { fail((e && e.message) || String(e)); }
        });
      });
    }

    function needId(id, what) {
      if (typeof id !== 'string' || !id) return Promise.reject(new Error(what + ' is required'));
      return null;
    }

    function startNew() {
      var id = crypto.randomUUID(), now = Date.now();
      return runTx(['drafts', 'meta'], 'readwrite', function (tx, fail, out) {
        tx.objectStore('drafts').put({
          draftId: id, createdAt: now, updatedAt: now,
          orderId: null, slug: null, resumeToken: null, orderStatus: null,
          details: blankDetails(), sceneOrder: [], cur: -1
        });
        tx.objectStore('meta').put({ key: 'currentDraftId', value: id });
        out.value = id;
      });
    }

    function getCurrentDraftId() {
      return runTx(['meta'], 'readonly', function (tx, fail, out) {
        out.value = null;
        var r = tx.objectStore('meta').get('currentDraftId');
        r.onsuccess = function () { out.value = r.result ? r.result.value : null; };
      });
    }

    function loadMeta(draftId) {
      return needId(draftId, 'draftId') || runTx(['drafts'], 'readonly', function (tx, fail, out) {
        out.value = null;
        var r = tx.objectStore('drafts').get(draftId);
        r.onsuccess = function () { out.value = r.result || null; };
      });
    }

    function saveMeta(draftId, patch) {
      return needId(draftId, 'draftId') || runTx(['drafts'], 'readwrite', function (tx, fail) {
        mergeDraft(tx.objectStore('drafts'), draftId, patch, fail);
      });
    }

    // scene: plain metadata (must have .id). blobs: Map<key, Blob> for this scene. metaPatch: merged
    // into the draft record in the SAME transaction (typically { sceneOrder, cur }).
    function saveScene(draftId, scene, blobs, metaPatch) {
      var bad = needId(draftId, 'draftId');
      if (bad) return bad;
      if (!scene || typeof scene.id !== 'string' || !scene.id) return Promise.reject(new Error('scene.id is required'));
      if (!(blobs instanceof Map)) return Promise.reject(new Error('blobs must be a Map<key, Blob>'));
      return runTx(['drafts', 'scenes', 'blobs'], 'readwrite', function (tx, fail) {
        var rec = Object.assign({}, scene, { draftId: draftId });
        delete rec.blobs; // never store a loaded scene's blob Map inside its own record
        tx.objectStore('scenes').put(rec);
        var bs = tx.objectStore('blobs');
        blobs.forEach(function (blob, key) { bs.put({ draftId: draftId, key: key, blob: blob }); });
        mergeDraft(tx.objectStore('drafts'), draftId, metaPatch || {}, fail);
      });
    }

    // Small, frequent edits (rename, hotspots, start view): patch the scene record, leave its blobs alone.
    function updateScene(draftId, sceneId, patch) {
      var bad = needId(draftId, 'draftId') || needId(sceneId, 'sceneId');
      if (bad) return bad;
      return runTx(['drafts', 'scenes'], 'readwrite', function (tx, fail) {
        var s = tx.objectStore('scenes'), g = s.get([draftId, sceneId]);
        g.onsuccess = function () {
          var rec = g.result;
          if (!rec) { fail('scene not found: ' + sceneId); return; }
          Object.keys(patch || {}).forEach(function (k) { if (k !== 'id' && k !== 'draftId') rec[k] = patch[k]; });
          s.put(rec);
          mergeDraft(tx.objectStore('drafts'), draftId, {}, fail);
        };
      });
    }

    function deleteScene(draftId, sceneId, metaPatch) {
      var bad = needId(draftId, 'draftId') || needId(sceneId, 'sceneId');
      if (bad) return bad;
      return runTx(['drafts', 'scenes', 'blobs'], 'readwrite', function (tx, fail) {
        tx.objectStore('scenes').delete([draftId, sceneId]);
        tx.objectStore('blobs').delete(sceneBlobRange(draftId, sceneId));
        mergeDraft(tx.objectStore('drafts'), draftId, metaPatch || {}, fail);
      });
    }

    function saveBlob(draftId, key, blob) {
      var bad = needId(draftId, 'draftId') || needId(key, 'key');
      if (bad) return bad;
      return runTx(['drafts', 'blobs'], 'readwrite', function (tx, fail) {
        tx.objectStore('blobs').put({ draftId: draftId, key: key, blob: blob });
        mergeDraft(tx.objectStore('drafts'), draftId, {}, fail);
      });
    }

    function deleteBlob(draftId, key) {
      var bad = needId(draftId, 'draftId') || needId(key, 'key');
      if (bad) return bad;
      return runTx(['drafts', 'blobs'], 'readwrite', function (tx, fail) {
        tx.objectStore('blobs').delete([draftId, key]);
        mergeDraft(tx.objectStore('drafts'), draftId, {}, fail);
      });
    }

    // Everything needed to rebuild the editor: { meta, scenes:[{...record, blobs:Map}], cover:Blob|null },
    // scenes in saved order. Returns null if there is no such draft.
    function load(draftId) {
      var bad = needId(draftId, 'draftId');
      if (bad) return bad;
      return runTx(['drafts', 'scenes', 'blobs'], 'readonly', function (tx, fail, out) {
        var raw = out.value = { d: null, s: [], b: [] };
        var dr = tx.objectStore('drafts').get(draftId);
        dr.onsuccess = function () { raw.d = dr.result || null; };
        var sr = tx.objectStore('scenes').getAll(draftRange(draftId));
        sr.onsuccess = function () { raw.s = sr.result; };
        var br = tx.objectStore('blobs').getAll(draftRange(draftId));
        br.onsuccess = function () { raw.b = br.result; };
      }).then(function (raw) {
        if (!raw.d) return null;
        var byScene = {}, cover = null;
        raw.b.forEach(function (r) {
          if (r.key === COVER_KEY) { cover = r.blob; return; }
          var sid = r.key.split('/')[0]; // scene ids never contain '/'
          (byScene[sid] = byScene[sid] || new Map()).set(r.key, r.blob);
        });
        var order = raw.d.sceneOrder || [];
        var scenes = raw.s.map(function (rec) { return Object.assign({}, rec, { blobs: byScene[rec.id] || new Map() }); });
        scenes.sort(function (a, b) {
          var ia = order.indexOf(a.id), ib = order.indexOf(b.id);
          return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
        });
        return { meta: raw.d, scenes: scenes, cover: cover };
      });
    }

    // Removes the draft and everything under it (call after a successful publish).
    function clearDraft(draftId) {
      var bad = needId(draftId, 'draftId');
      if (bad) return bad;
      return runTx(['drafts', 'scenes', 'blobs', 'meta'], 'readwrite', function (tx) {
        tx.objectStore('drafts').delete(draftId);
        tx.objectStore('scenes').delete(draftRange(draftId));
        tx.objectStore('blobs').delete(draftRange(draftId));
        var meta = tx.objectStore('meta'), g = meta.get('currentDraftId');
        g.onsuccess = function () { if (g.result && g.result.value === draftId) meta.delete('currentDraftId'); };
      });
    }

    function debugCounts(draftId) {
      return runTx(['scenes', 'blobs'], 'readonly', function (tx, fail, out) {
        var c = out.value = { scenes: -1, blobs: -1 };
        var a = tx.objectStore('scenes').count(draftRange(draftId));
        a.onsuccess = function () { c.scenes = a.result; };
        var b = tx.objectStore('blobs').count(draftRange(draftId));
        b.onsuccess = function () { c.blobs = b.result; };
      });
    }

    function estimate() {
      if (navigator.storage && navigator.storage.estimate) {
        return navigator.storage.estimate().then(function (e) { return { usage: e.usage || 0, quota: e.quota || 0 }; }, function () { return null; });
      }
      return Promise.resolve(null);
    }

    // Asks the browser not to evict this origin's storage. Best called right after a user action.
    function requestPersistence() {
      if (navigator.storage && navigator.storage.persist) {
        return navigator.storage.persist().then(function (ok) { return !!ok; }, function () { return false; });
      }
      return Promise.resolve(false);
    }

    function close() {
      var p = dbPromise; dbPromise = null;
      if (!p) return Promise.resolve();
      return p.then(function (db) { db.close(); }, function () {});
    }

    function deleteDatabase() {
      return close().then(function () {
        return new Promise(function (resolve, reject) {
          var req = indexedDB.deleteDatabase(dbName);
          req.onsuccess = function () { resolve(); };
          req.onerror = function () { reject(req.error); };
          req.onblocked = function () { resolve(); }; // another connection is still open; it completes when that closes
        });
      });
    }

    return {
      startNew: startNew, getCurrentDraftId: getCurrentDraftId, loadMeta: loadMeta, saveMeta: saveMeta,
      saveScene: saveScene, updateScene: updateScene, deleteScene: deleteScene,
      saveBlob: saveBlob, deleteBlob: deleteBlob, load: load, clearDraft: clearDraft,
      debugCounts: debugCounts, estimate: estimate, requestPersistence: requestPersistence,
      close: close, deleteDatabase: deleteDatabase,
      COVER_KEY: COVER_KEY, thumbKey: thumbKey, fallbackKey: fallbackKey, isQuotaError: isQuotaError
    };
  }

  // Runs against a throwaway database in the real browser engine, then deletes it. Run from the
  // console:  G360Draft.selfTest()
  async function selfTest() {
    var d = create('glow360-selftest-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
    var results = [];
    function check(name, cond, detail) { results.push({ test: name, pass: !!cond, detail: cond ? '' : (detail || '') }); }
    function mkBlob(n, byte) { return new Blob([new Uint8Array(n).fill(byte)], { type: 'image/jpeg' }); }
    var A = '0-room', B = '0-room-2'; // B's id starts with A's id: proves deleting A can't touch B
    try {
      var id = await d.startNew();
      check('startNew returns a uuid', /^[0-9a-f-]{36}$/.test(id), id);
      check('current draft id is remembered', (await d.getCurrentDraftId()) === id);
      var m = await d.loadMeta(id);
      check('new draft starts with safe defaults (unlisted true, rights false)',
        m && m.details.unlisted === true && m.details.rightsConfirmed === false, JSON.stringify(m && m.details));
      await d.saveMeta(id, { orderId: 'o1', slug: 's1', resumeToken: 't1', details: { address: '1 Test St' } });
      m = await d.loadMeta(id);
      check('saveMeta merges top-level fields', m.orderId === 'o1' && m.slug === 's1' && m.resumeToken === 't1');
      check('saveMeta deep-merges details without wiping siblings', m.details.address === '1 Test St' && m.details.unlisted === true);

      var blobsA = new Map([
        [A + '/preview.jpg', mkBlob(10, 1)], [A + '/1/f/0/0.jpg', mkBlob(20, 2)],
        [d.thumbKey(A), mkBlob(5, 3)], [d.fallbackKey(A, 'f'), mkBlob(6, 4)]
      ]);
      var blobsB = new Map([[B + '/preview.jpg', mkBlob(11, 5)], [B + '/1/f/0/0.jpg', mkBlob(21, 6)]]);
      await d.saveScene(id, { id: A, name: 'Room A', faceSize: 512, links: [], infos: [] }, blobsA, { sceneOrder: [A], cur: 0 });
      await d.saveScene(id, { id: B, name: 'Room B', faceSize: 512, links: [], infos: [] }, blobsB, { sceneOrder: [A, B], cur: 1 });
      var L = await d.load(id);
      check('load returns both scenes in saved order', L.scenes.length === 2 && L.scenes[0].id === A && L.scenes[1].id === B);
      check('each scene gets exactly its own blobs', L.scenes[0].blobs.size === 4 && L.scenes[1].blobs.size === 2,
        L.scenes.map(function (s) { return s.id + ':' + s.blobs.size; }).join(', '));
      var got = L.scenes[0].blobs.get(A + '/1/f/0/0.jpg');
      var buf = new Uint8Array(await got.arrayBuffer());
      check('blob bytes survive the round trip', buf.length === 20 && buf[0] === 2 && buf[19] === 2);
      check('blob mime type survives', got.type === 'image/jpeg', got.type);
      check('cur is persisted through the metaPatch', L.meta.cur === 1, String(L.meta.cur));

      await d.updateScene(id, A, { links: [{ yaw: 1, pitch: 2, target: B }], name: 'Renamed' });
      L = await d.load(id);
      check('updateScene patches a scene without touching its blobs',
        L.scenes[0].name === 'Renamed' && L.scenes[0].links.length === 1 && L.scenes[0].blobs.size === 4);

      await d.saveMeta(id, { sceneOrder: [B, A] });
      L = await d.load(id);
      check('reordering via saveMeta changes the order load returns', L.scenes[0].id === B && L.scenes[1].id === A);

      await d.saveBlob(id, d.COVER_KEY, mkBlob(30, 9));
      L = await d.load(id);
      check('cover blob round trips and is not mistaken for a scene blob',
        L.cover && L.cover.size === 30 && L.scenes[0].blobs.size === 2 && L.scenes[1].blobs.size === 4);

      await d.deleteScene(id, A, { sceneOrder: [B], cur: 0 });
      L = await d.load(id);
      check('deleting a scene removes only its own blobs (prefix-safe, cover untouched)',
        L.scenes.length === 1 && L.scenes[0].id === B && L.scenes[0].blobs.size === 2 && L.cover && L.cover.size === 30,
        JSON.stringify({ scenes: L.scenes.length, blobs: L.scenes[0] && L.scenes[0].blobs.size }));

      var rejected = false;
      try { await d.saveScene('no-such-draft', { id: 'z', name: 'Z' }, new Map([['z/preview.jpg', mkBlob(3, 1)]]), {}); }
      catch (e) { rejected = true; }
      check('saving into a missing draft is rejected', rejected);
      var orphans = await d.debugCounts('no-such-draft');
      check('...and rolls back completely (no orphaned scene or blob records)', orphans.scenes === 0 && orphans.blobs === 0, JSON.stringify(orphans));

      await d.clearDraft(id);
      check('clearDraft removes the draft', (await d.load(id)) === null);
      check('clearDraft clears the current-draft pointer', (await d.getCurrentDraftId()) === null);
      var left = await d.debugCounts(id);
      check('clearDraft leaves no scene or blob records behind', left.scenes === 0 && left.blobs === 0, JSON.stringify(left));
    } catch (e) {
      check('self test ran to completion without throwing', false, (e && e.message) || String(e));
    } finally {
      try { await d.deleteDatabase(); } catch (e) {}
    }
    var failed = results.filter(function (r) { return !r.pass; });
    console.table(results);
    console.log(failed.length
      ? 'G360Draft self-test: ' + failed.length + ' FAILED of ' + results.length
      : 'G360Draft self-test: all ' + results.length + ' passed');
    return { passed: results.length - failed.length, failed: failed.length, results: results };
  }

  var api = create('glow360-tour-builder');
  api.create = create;
  api.selfTest = selfTest;
  return api;
})();
