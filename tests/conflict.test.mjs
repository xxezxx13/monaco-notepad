import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const sourcePath = fileURLToPath(new URL('../src/main/conflict.ts', import.meta.url))
const compiled = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText

const module = { exports: {} }
vm.runInNewContext(compiled, {
  __dirname: dirname(sourcePath),
  module,
  exports: module.exports,
  require(name) {
    if (name === 'node:path') return { resolve }
    if (name === 'node:fs') return nodeFs
    throw new Error(`Unexpected import: ${name}`)
  }
})

const { createSaveBaselineTracker, fileSignature } = module.exports

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Test helper.
async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'monaco-notepad-conflict-'))
  t.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }))
  )
  return directory
}

test('fileSignature returns stable identity for unchanged file', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'stable.txt')
  await writeFile(file, 'hello')

  const first = fileSignature(file)
  const second = fileSignature(file)
  assert.equal(first, second)
  assert.ok(first.includes('hello'.length))
})

test('fileSignature returns null for missing file', async (t) => {
  const directory = await temporaryDirectory(t)
  const signature = fileSignature(join(directory, 'missing.txt'))
  assert.equal(signature, null)
})

test('unchanged file passes baseline check', async (t) => {
  const directory = await temporaryDirectory(t)
  const tracker = createSaveBaselineTracker()
  const file = join(directory, 'unchanged.txt')
  await writeFile(file, 'original')

  tracker.record(file)
  assert.equal(tracker.check(file), false)
})

test('externally modified file fails baseline check', async (t) => {
  const directory = await temporaryDirectory(t)
  const tracker = createSaveBaselineTracker()
  const file = join(directory, 'changed.txt')
  await writeFile(file, 'original')

  tracker.record(file)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(file, 'external edit')

  assert.equal(tracker.check(file), true)
})

test('recording baseline after save resets conflict check', async (t) => {
  const directory = await temporaryDirectory(t)
  const tracker = createSaveBaselineTracker()
  const file = join(directory, 'reset.txt')
  await writeFile(file, 'original')

  tracker.record(file)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(file, 'external edit')
  assert.equal(tracker.check(file), true)

  tracker.record(file)
  assert.equal(tracker.check(file), false)
})

test('recordSignature preserves the captured baseline instead of rereading later disk state', async (t) => {
  const directory = await temporaryDirectory(t)
  const tracker = createSaveBaselineTracker()
  const file = join(directory, 'captured.txt')

  await writeFile(file, 'original')
  const captured = fileSignature(file)
  assert.ok(captured)

  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(file, 'external edit')

  tracker.recordSignature(file, captured)
  assert.equal(tracker.check(file), true)
})

test('different path is not compared to baseline', async (t) => {
  const directory = await temporaryDirectory(t)
  const tracker = createSaveBaselineTracker()
  const a = join(directory, 'a.txt')
  const b = join(directory, 'b.txt')
  await writeFile(a, 'a')
  await writeFile(b, 'b')

  tracker.record(a)
  assert.equal(tracker.check(b), false)
})

test('symlink target changes are detected through symlink path', async (t) => {
  const directory = await temporaryDirectory(t)
  const tracker = createSaveBaselineTracker()
  const target = join(directory, 'target.txt')
  const link = join(directory, 'link.txt')
  await writeFile(target, 'original')
  await symlink('target.txt', link)

  tracker.record(link)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(target, 'external edit')

  assert.equal(tracker.check(link), true)
})

test('currentPath returns resolved absolute path', async (t) => {
  const directory = await temporaryDirectory(t)
  const tracker = createSaveBaselineTracker()
  const file = join(directory, 'path.txt')
  await writeFile(file, 'x')

  tracker.record(file)
  assert.equal(tracker.currentPath(), resolve(file))
})
