// Assembles src/template.html + src/core.js + src/api.js + src/draft.js + src/app.js into ONE
// self-contained page and writes it to ../create-tour.html -- the file Vercel serves at
// glow360.co.nz/create-tour.html. Vercel runs no build: run this locally and commit the output
// (same pattern as scripts/generate-pages.js in the tours repo). No dependencies.
// Script order matters: core, api and draft must be defined before app runs.
const fs = require('fs'), path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const tpl = read('template.html');
for (const p of ['/*CORE*/', '/*API*/', '/*DRAFT*/', '/*APP*/']) {
  if (!tpl.includes(p)) throw new Error('src/template.html is missing the ' + p + ' placeholder');
}
const core = read('core.js').replace("if (typeof module !== 'undefined') module.exports = G360;", '');
const html = tpl
  .replace('/*CORE*/', () => core)
  .replace('/*API*/', () => read('api.js'))
  .replace('/*DRAFT*/', () => read('draft.js'))
  .replace('/*APP*/', () => read('app.js'));
const out = path.join(__dirname, '..', 'create-tour.html');
fs.writeFileSync(out, html);
console.log('Built ' + out + ' (' + html.length + ' bytes)');
