# Glow360 tour builder: prototype source

Reference implementation for `Glow360_Engineer_Build_Brief.md`. **The prototype is the UI specification.** Port it; do not redesign it.

    src/core.js       Pure functions, no DOM: cube-face projection, tile levels, key naming, data.js serializer,
                      validators (address, listing URL), aspect/FOV helpers. Tested against Marzipano's own geometry.
    src/app.js        The editor: tiling, scene rail (drag to reorder), hotspot tools, details dialog (publish is a stub).
    src/template.html Markup + all CSS (theme tokens at the top of the <style> block).
    test/core.test.js Node tests (oracle test compares our face maths with Marzipano's CubeTile.vertices()).
    build.js          Inlines core + app into dist/glow360-tour-builder.html (what was published as the demo).

    npm install && npm test && npm run build

What is deliberately NOT here (see brief): persistence, web worker, preview.jpg, name/email fields, real publish,
upload, backend, payment. Everything in the browser stays client-side until Publish.
