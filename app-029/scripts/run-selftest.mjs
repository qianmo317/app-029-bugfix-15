import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Polyfill fetch so fontLoader can load public/fonts/*.otf over file://
globalThis.fetch = async (url) => {
  const u = String(url)
  const rel = u.replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '')
  const buf = await readFile(join(process.cwd(), 'public', rel))
  return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
}

const { runAcceptance, defaultPreset } = await import('./selftest.bundle.mjs')
const report = await runAcceptance(defaultPreset)
for (const c of report.checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.id} ${c.title}`)
  if (!c.pass) console.log(`   ${c.detail}`)
  for (const e of c.evidence) console.log(`   · ${e}`)
}
console.log(`\nallPass=${report.allPass} elapsed=${report.elapsedMs.toFixed(0)}ms`)
process.exit(report.allPass ? 0 : 1)
