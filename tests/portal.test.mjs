import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const sourcePath = fileURLToPath(new URL('../src/main/portal.ts', import.meta.url))
const module = { exports: {} }
vm.runInNewContext(
  ts.transpileModule(await readFile(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText,
  { module, exports: module.exports }
)

const { portalThemeFromOutput } = module.exports

test('XDG portal color scheme values map defensively', () => {
  assert.equal(portalThemeFromOutput('(<uint32 1>,)'), 'dark')
  assert.equal(portalThemeFromOutput('(<uint32 2>,)'), 'light')
  assert.equal(portalThemeFromOutput('(<uint32 0>,)'), null)
  assert.equal(portalThemeFromOutput('unavailable'), null)
})
