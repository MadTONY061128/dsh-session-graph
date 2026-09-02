// Build the browser bundle: wrap client-src.js in the ModuleLoader factory.
// Output: dist/client.js  (one file, only external dependency: react via require)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const src = readFileSync(`${root}client-src.js`, 'utf8')

const out = `window.__ModuleLoader__.load({
  id: "dsh-session-graph",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${src}
    return module.exports;
  }
});
`

writeFileSync(`${root}dist/client.js`, out)
console.log('dist/client.js written:', (out.length / 1024).toFixed(1), 'KiB')
