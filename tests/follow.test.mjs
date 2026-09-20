/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rename, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const sourcePath = fileURLToPath(new URL('../src/main/follow.ts', import.meta.url))
const module = { exports: {} }
const compiled = ts.transpileModule(
  await import('node:fs/promises').then((fs) => fs.readFile(sourcePath, 'utf8')),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }
).outputText
vm.runInNewContext(compiled, { module, exports: module.exports, require, Buffer })
const { FollowReader } = module.exports

const plain = (value) => JSON.parse(JSON.stringify(value))

async function fixture(t, initial = Buffer.from('start')) {
  const directory = await mkdtemp(join(tmpdir(), 'monaco-notepad-follow-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'follow.log')
  await writeFile(file, initial)
  return { directory, file }
}

test('follow reads only appended bytes and ignores duplicate polls', async (t) => {
  const { file } = await fixture(t)
  const reader = await FollowReader.create(file, 'utf8')
  await appendFile(file, ' next')
  assert.deepEqual(plain(await reader.poll()), [{ kind: 'append', text: ' next', from: 5, to: 10 }])
  assert.deepEqual(plain(await reader.poll()), [])
})

test('UTF-8 split characters survive event boundaries', async (t) => {
  const { file } = await fixture(t, Buffer.alloc(0))
  const reader = await FollowReader.create(file, 'utf8')
  const emoji = Buffer.from('😀')
  await appendFile(file, emoji.subarray(0, 2))
  assert.equal((await reader.poll())[0].text, '')
  await appendFile(file, emoji.subarray(2))
  assert.equal((await reader.poll())[0].text, '😀')
})

for (const encoding of ['utf16le', 'utf16be']) {
  test(`${encoding} split code units and surrogate pairs survive`, async (t) => {
    const { file } = await fixture(t, Buffer.alloc(0))
    const reader = await FollowReader.create(file, encoding)
    const little = Buffer.from('😀', 'utf16le')
    const bytes =
      encoding === 'utf16le' ? little : Buffer.from([little[1], little[0], little[3], little[2]])
    await appendFile(file, bytes.subarray(0, 1))
    assert.equal((await reader.poll())[0].text, '')
    await appendFile(file, bytes.subarray(1, 2))
    assert.equal((await reader.poll())[0].text, '')
    await appendFile(file, bytes.subarray(2))
    assert.equal((await reader.poll())[0].text, '😀')
  })
}

test('truncation and identity replacement reset content deterministically', async (t) => {
  const { directory, file } = await fixture(t, Buffer.from('old content'))
  const reader = await FollowReader.create(file, 'utf8')
  await truncate(file, 3)
  assert.deepEqual(plain(await reader.poll()), [
    { kind: 'reset', text: 'old', reason: 'truncated', from: 0, to: 3 }
  ])
  await rename(file, join(directory, 'rotated.log'))
  await writeFile(file, 'new file')
  assert.deepEqual(plain(await reader.poll()), [
    { kind: 'reset', text: 'new file', reason: 'rotated', from: 0, to: 8 }
  ])
})

test('deletion waits and recreation restarts', async (t) => {
  const { file } = await fixture(t)
  const reader = await FollowReader.create(file, 'utf8')
  await unlink(file)
  assert.deepEqual(plain(await reader.poll()), [{ kind: 'waiting' }])
  assert.deepEqual(plain(await reader.poll()), [])
  await writeFile(file, 'back')
  assert.deepEqual(plain(await reader.poll()), [
    { kind: 'reset', text: 'back', reason: 'recreated', from: 0, to: 4 }
  ])
})
