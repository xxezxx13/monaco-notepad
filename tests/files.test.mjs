import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  lstat,
  stat,
  symlink,
  rm
} from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the real TypeScript file and real filesystem without starting
// Electron. Only native dialogs and persisted UI preferences are substituted.
const sourcePath = fileURLToPath(new URL('../src/main/files.ts', import.meta.url))
const require = createRequire(sourcePath)
const dialogCalls = []
const fileReads = []
let dialogResponse = 1
let saveDialogPath = null
const dialog = {
  async showMessageBox(...args) {
    dialogCalls.push(args)
    return { response: dialogResponse }
  },
  async showSaveDialog() {
    return { canceled: !saveDialogPath, filePath: saveDialogPath }
  }
}
const module = { exports: {} }
const compiled = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText
vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  Buffer,
  TextDecoder,
  require(name) {
    if (name === 'electron') return { dialog }
    if (name === './preferences')
      return {
        preferences: {
          set: () => undefined,
          get: (key) => (key === 'largeFileWarningMiB' ? 20 : null)
        }
      }
    if (name === 'node:fs/promises') {
      return {
        ...filesystem,
        readFile(...args) {
          fileReads.push(args[0])
          return filesystem.readFile(...args)
        }
      }
    }
    return require(name)
  }
})
const {
  decodeTextFile,
  decodeTextFileWithEncoding,
  detectBomlessUtf16,
  encodeTextFile,
  getFileReadOnly,
  isLikelyBinary,
  openFilePath,
  reopenFilePath,
  saveFile,
  writeTextFileAtomic
} = module.exports

test('all supported large-file warning thresholds map to exact MiB values', () => {
  for (const threshold of [10, 20, 50, 100]) {
    assert.equal(module.exports.largeFileWarningBytes(threshold), threshold * 1024 * 1024)
  }
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Executable JavaScript test.
async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'monaco-notepad-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('all five encodings round-trip Unicode/ANSI text and CRLF', () => {
  const text = 'café résumé £ € “quotes” —\r\nsecond line\r\n'
  for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'windows1252']) {
    const bytes = encodeTextFile(text, encoding)
    const decoded = decodeTextFile(bytes)
    assert.equal(decoded.text, text, encoding)
    assert.equal(decoded.encoding, encoding)
  }
  assert.equal(decodeTextFile(Buffer.from('Hello 世界')).encoding, 'utf8')
  assert.throws(() => encodeTextFile('Hello 世界', 'windows1252'), /cannot be represented/)
})

test('explicit decoding honors the selected encoding without auto-detection', () => {
  const text = 'café résumé £ € “quotes” —\r\nsecond line\r\n'

  for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'windows1252']) {
    const bytes = encodeTextFile(text, encoding)
    const decoded = decodeTextFileWithEncoding(bytes, encoding)

    assert.equal(decoded.text, text, encoding)
    assert.equal(decoded.encoding, encoding)
  }

  const utf8Bytes = Buffer.from('café', 'utf8')
  assert.equal(decodeTextFileWithEncoding(utf8Bytes, 'utf8').text, 'café')
  assert.equal(decodeTextFileWithEncoding(utf8Bytes, 'windows1252').text, 'cafÃ©')
})

test('BOM-less UTF-16 is detected before binary classification', () => {
  const text = 'Hello world\r\nsecond line'

  const littleEndian = Buffer.from(text, 'utf16le')
  const bigEndian = Buffer.allocUnsafe(littleEndian.length)

  for (let i = 0; i < littleEndian.length; i += 2) {
    bigEndian[i] = littleEndian[i + 1]
    bigEndian[i + 1] = littleEndian[i]
  }

  assert.equal(detectBomlessUtf16(littleEndian), 'utf16le')
  assert.equal(detectBomlessUtf16(bigEndian), 'utf16be')
  assert.equal(isLikelyBinary(littleEndian), false)
  assert.equal(isLikelyBinary(bigEndian), false)

  const decodedLe = decodeTextFile(littleEndian)
  assert.equal(decodedLe.encoding, 'utf16le')
  assert.equal(decodedLe.text, text)

  const decodedBe = decodeTextFile(bigEndian)
  assert.equal(decodedBe.encoding, 'utf16be')
  assert.equal(decodedBe.text, text)
})

test('binary heuristic accepts normal text and rejects NUL/control-heavy data', () => {
  assert.equal(isLikelyBinary(Buffer.from('plain text\nsecond line\n')), false)
  assert.equal(isLikelyBinary(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x10])), true)
  assert.equal(isLikelyBinary(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x41, 0x42, 0x43])), true)
})

test('atomic saves preserve executable mode and ownership', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'script.sh')
  await writeFile(file, '#!/bin/sh\necho before\n')
  await chmod(file, 0o751)
  const original = await stat(file)
  await writeTextFileAtomic(file, '#!/bin/sh\necho after\n', 'utf8')
  const saved = await stat(file)
  assert.equal(saved.mode & 0o7777, 0o751)
  assert.equal(saved.uid, original.uid)
  assert.equal(saved.gid, original.gid)
  assert.equal(await readFile(file, 'utf8'), '#!/bin/sh\necho after\n')
  assert.notEqual(saved.ino, original.ino, 'saving should atomically replace the target')
})

test('saving a symlink preserves the link and target permissions', async (t) => {
  const directory = await temporaryDirectory(t)
  const target = join(directory, 'target.sh')
  const link = join(directory, 'link.sh')
  await writeFile(target, 'before')
  await chmod(target, 0o750)
  await symlink('target.sh', link)
  assert.equal(await getFileReadOnly(link), false)
  await writeTextFileAtomic(link, 'after', 'utf8')
  assert.equal((await lstat(link)).isSymbolicLink(), true)
  assert.equal(await readFile(target, 'utf8'), 'after')
  assert.equal((await stat(target)).mode & 0o7777, 0o750)
})

test('a dangling symlink is never replaced or silently recreated', async (t) => {
  const directory = await temporaryDirectory(t)
  const link = join(directory, 'link.txt')
  await symlink('missing.txt', link)
  assert.equal(await getFileReadOnly(link), true)
  await assert.rejects(writeTextFileAtomic(link, 'unsaved text', 'utf8'), /symbolic link target/)
  assert.equal((await lstat(link)).isSymbolicLink(), true)
  await assert.rejects(stat(join(directory, 'missing.txt')), { code: 'ENOENT' })
})

test('read-only files are reported and cannot be bypassed by atomic replacement', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'readonly.txt')
  await writeFile(file, 'original')
  await chmod(file, 0o444)
  assert.equal(await getFileReadOnly(file), true)
  const opened = await openFilePath(file)
  assert.equal(opened.readOnly, true)
  assert.equal(opened.text, 'original')
  await assert.rejects(writeTextFileAtomic(file, 'edits', 'utf8'), /read-only/)
  assert.equal(await readFile(file, 'utf8'), 'original')
  const saveAs = join(directory, 'copy.txt')
  await writeTextFileAtomic(saveAs, 'edits', 'utf8')
  assert.equal(await readFile(saveAs, 'utf8'), 'edits')
})

test('read-only target directories are detected even through symlinks', async (t) => {
  const directory = await temporaryDirectory(t)
  const targetDirectory = join(directory, 'locked')
  await mkdir(targetDirectory)
  const file = join(targetDirectory, 'text.txt')
  const link = join(directory, 'link.txt')
  await writeFile(file, 'original')
  await symlink(file, link)
  await chmod(targetDirectory, 0o555)
  try {
    assert.equal(await getFileReadOnly(link), true)
    await assert.rejects(writeTextFileAtomic(link, 'edits', 'utf8'), /directory is read-only/)
    assert.equal(await readFile(file, 'utf8'), 'original')
  } finally {
    await chmod(targetDirectory, 0o755)
  }
})

test('deleted ordinary files can be recreated, and rejected ANSI saves preserve bytes', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'deleted.txt')
  await writeFile(file, 'original')
  await rm(file)
  assert.equal(await getFileReadOnly(file), false)
  await writeTextFileAtomic(file, 'restored', 'utf8')
  await assert.rejects(
    writeTextFileAtomic(file, 'Hello 世界', 'windows1252'),
    /cannot be represented/
  )
  assert.equal(await readFile(file, 'utf8'), 'restored')
})

test('likely-binary files require explicit read-only acceptance', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'binary.dat')
  await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x10]))

  const parentWindow = {}
  dialogCalls.length = 0
  fileReads.length = 0
  dialogResponse = 1

  assert.equal(await openFilePath(file, 'auto', parentWindow), null)
  assert.equal(fileReads.length, 0)
  assert.equal(dialogCalls.length, 1)
  assert.deepEqual([...dialogCalls[0][1].buttons], ['Open Read-Only Anyway', 'Cancel'])
  assert.equal(dialogCalls[0][1].cancelId, 1)

  dialogResponse = 0
  const opened = await openFilePath(file, 'auto', parentWindow)

  assert.equal(opened.forcedReadOnly, true)
  assert.equal(fileReads.length, 1)
})

test('Safe Open protected paths cannot be overwritten', async (t) => {
  const directory = await temporaryDirectory(t)
  const original = join(directory, 'original.dat')
  const copy = join(directory, 'copy.txt')
  const originalBytes = Buffer.from([0x00, 0x01, 0x02, 0x03])

  await writeFile(original, originalBytes)

  await assert.rejects(
    saveFile(
      {},
      {
        filePath: original,
        text: 'replacement',
        encoding: 'utf8',
        protectedPath: original
      }
    ),
    /Safe Open prevents overwriting/
  )

  assert.deepEqual(await readFile(original), originalBytes)

  saveDialogPath = original
  await assert.rejects(
    saveFile(
      {},
      {
        filePath: null,
        text: 'replacement',
        encoding: 'utf8',
        protectedPath: original
      }
    ),
    /Safe Open prevents overwriting/
  )

  assert.deepEqual(await readFile(original), originalBytes)

  saveDialogPath = copy
  const saved = await saveFile(
    {},
    {
      filePath: null,
      text: 'safe copy',
      encoding: 'utf8',
      protectedPath: original
    }
  )

  assert.equal(saved, copy)
  assert.equal(await readFile(copy, 'utf8'), 'safe copy')
  assert.deepEqual(await readFile(original), originalBytes)

  saveDialogPath = null
})

test('explicit reopen preserves Safe Open protection for likely binary files', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'binary-reopen.dat')
  await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x10]))

  dialogResponse = 1
  assert.equal(await reopenFilePath(file, 'utf8'), null)

  dialogResponse = 0
  const reopened = await reopenFilePath(file, 'utf8')

  assert.ok(reopened)
  assert.equal(reopened.encoding, 'utf8')
  assert.equal(reopened.forcedReadOnly, true)
})

test('large-file Cancel reads no content; Open reads the complete file', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'large.txt')
  const ending = '\r\nlast line café'
  const text =
    'x'.repeat(module.exports.DEFAULT_LARGE_FILE_WARNING_BYTES - Buffer.byteLength(ending)) + ending
  await writeFile(file, text)
  dialogCalls.length = 0
  fileReads.length = 0
  dialogResponse = 1
  const parentWindow = {}
  assert.equal(await openFilePath(file, 'auto', parentWindow), null)
  assert.equal(fileReads.length, 0)
  assert.equal(dialogCalls.length, 1)
  assert.equal(dialogCalls[0][0], parentWindow)
  assert.deepEqual([...dialogCalls[0][1].buttons], ['Open', 'Cancel'])
  assert.equal(dialogCalls[0][1].cancelId, 1)

  dialogResponse = 0
  const opened = await openFilePath(file, 'auto', parentWindow)
  assert.equal(opened.text, text)
  assert.equal(opened.eol, 'CRLF')
  assert.equal(opened.encoding, 'utf8')
  assert.equal(opened.readOnly, false)
  assert.equal(opened.forcedReadOnly, false)
  assert.equal(opened.size, Buffer.byteLength(text))
  assert.equal(fileReads.length, 1)
})

test('small files open without warning; directories cannot be opened as files', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'small.txt')
  await writeFile(file, Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  dialogCalls.length = 0
  const opened = await openFilePath(file)
  assert.equal(opened.text, 'café')
  assert.equal(opened.encoding, 'windows1252')
  assert.equal(opened.forcedReadOnly, false)
  assert.equal(dialogCalls.length, 0)
  await assert.rejects(openFilePath(dirname(file)), /regular files/)
})
