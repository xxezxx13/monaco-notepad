import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const sourcePath = fileURLToPath(new URL('../src/main/selection-hash.ts', import.meta.url))
const module = { exports: {} }
const compiled = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText
vm.runInNewContext(compiled, { module, exports: module.exports, require })
const { selectionDigests } = module.exports

test('selection hashes match known vectors and preserve selection order', () => {
  assert.deepEqual(selectionDigests('sha256', ['abc']), [
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  ])
  assert.deepEqual(selectionDigests('sha1', ['abc']), ['a9993e364706816aba3e25717850c26c9cd0d89d'])
  assert.deepEqual(selectionDigests('md5', ['abc']), ['900150983cd24fb0d6963f7d28e17f72'])
  assert.equal(selectionDigests('sha256', ['😀'])[0].length, 64)
  assert.equal(selectionDigests('md5', ['one', 'two']).length, 2)
})

test('selection hashing rejects empty input and unknown algorithms', () => {
  assert.throws(() => selectionDigests('sha256', []), /Select text/)
  assert.throws(() => selectionDigests('sha512', ['abc']), /Unsupported/)
})
