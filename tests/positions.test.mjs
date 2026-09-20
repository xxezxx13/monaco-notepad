import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the preference helpers without starting Electron.
const sourcePath = fileURLToPath(new URL('../src/main/preferences.ts', import.meta.url))
const require = createRequire(sourcePath)
const module = { exports: {} }

const store = { data: {} }
const compiled = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText

vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  require(name) {
    if (name === 'electron-store') {
      return class {
        constructor({ defaults }) {
          Object.assign(store.data, defaults)
        }
        // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Test double method.
        get(key) {
          return store.data[key]
        }
        // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Test double method.
        set(key, value) {
          store.data[key] = value
        }
      }
    }
    return require(name)
  }
})

const { getFilePosition, saveFilePosition } = module.exports

test('file position save caps at 20 entries and evicts oldest', () => {
  for (let i = 0; i < 25; i++) {
    saveFilePosition(`/tmp/file${i}.txt`, {
      line: i + 1,
      column: 1,
      scrollTop: i * 100,
      accessedAt: i
    })
  }

  const positions = store.data.filePositions
  assert.equal(Object.keys(positions).length, 20)

  for (let i = 0; i < 5; i++) {
    assert.equal(positions[resolve(`/tmp/file${i}.txt`)], undefined)
  }

  for (let i = 5; i < 25; i++) {
    const position = positions[resolve(`/tmp/file${i}.txt`)]
    assert.ok(position)
    assert.equal(position.line, i + 1)
  }
})

test('file position get returns stored position or null', () => {
  const stored = getFilePosition('/tmp/file24.txt')
  assert.equal(stored.line, 25)

  const missing = getFilePosition('/tmp/unknown.txt')
  assert.equal(missing, null)
})

test('file position save updates access time on existing entry', () => {
  const path = '/tmp/recent.txt'
  saveFilePosition(path, { line: 1, column: 1, scrollTop: 0, accessedAt: Date.now() })
  const firstAccess = store.data.filePositions[resolve(path)].accessedAt

  saveFilePosition(path, { line: 5, column: 3, scrollTop: 100, accessedAt: Date.now() + 1000 })
  const updated = store.data.filePositions[resolve(path)]
  assert.equal(updated.line, 5)
  assert.equal(updated.column, 3)
  assert.equal(updated.scrollTop, 100)
  assert.ok(updated.accessedAt >= firstAccess)
})
