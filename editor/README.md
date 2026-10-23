# Glow360 tour editor (source)

This folder is the source of the self-service tour editor. `npm run build` writes ONE self-contained
page, `../create-tour.html`, which Vercel serves at glow360.co.nz/create-tour.html.

**Vercel runs no build.** Build locally and commit the source and the regenerated page together.
**Never edit `../create-tour.html` by hand.** It is generated output and the next build overwrites it.

    src/core.js        Pure functions, no DOM: cube-face projection, tile levels, key naming, data.js
                       serializer, validators (address, listing URL), pricing, aspect/FOV helpers.
                       Tested against Marzipano's own geometry.
    src/api.js         G360Api: the four public Edge Functions (create-order, upload-urls, finalize,
                       get-order). Returns {ok, ...} objects and never throws.
    src/draft.js       G360Draft: IndexedDB persistence for a tour in progress. Has an in-browser
                       self-test: open the page from a local server and run G360Draft.selfTest().
    src/app.js         The editor: tiling, scene rail (drag to reorder), hotspot tools, details dialog,
                       and saving/restoring the draft.
    src/template.html  Markup and all CSS (theme tokens at the top of the <style> block).
    test/core.test.js  Node tests for core.js.
    build.js           Joins template + core + api + draft + app into ../create-tour.html.

    npm install && npm test && npm run build

## Working on it

1. Edit under `src/`, then `npm test` and `npm run build`.
2. Serve the repo root (`python3 -m http.server 8000`) and open http://localhost:8000/create-tour.html.
   Do not open it as `file://`: Chrome gives file pages an opaque origin and IndexedDB is unreliable there.
3. Check it in a browser, then commit the source and `create-tour.html` together.

## Draft saving

A scene is saved to IndexedDB the moment it finishes tiling. Everything else is found by a one-second
dirty check, so no individual edit needs its own save call. The draft id is the same uuid the order API
takes as `draftId`. One browser tab per draft. Browsers can evict this storage (Safari after ~7 days
without a visit), so it protects against reloads and crashes, not against walking away for weeks.

## Not built yet

Client name and email fields, the visibility toggle and rights declaration, cover-image capture, the
Web Worker for tiling, and the real publish flow (create order, pay, upload, finalize).

Origin: this began as the standalone prototype in ~/Downloads/glow360-tour-builder-prototype, which is
now frozen reference only. This folder is the source of truth.
