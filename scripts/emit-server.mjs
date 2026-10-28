import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'server-dist')

function filesIn(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesIn(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

for (const file of [...filesIn(path.join(root, 'server')), ...filesIn(path.join(root, 'shared'))]) {
  const source = readFileSync(file, 'utf8')
  const stripped = stripTypeScriptTypes(source, { mode: 'transform' })
  const javascript = stripped.replace(/(from\s+['"])([^'"]+)\.ts(['"])/g, '$1$2.js$3')
  const relative = path.relative(root, file).replace(/\.ts$/, '.js')
  const destination = path.join(outDir, relative)
  mkdirSync(path.dirname(destination), { recursive: true })
  writeFileSync(destination, javascript)
}
