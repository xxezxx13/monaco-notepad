import { dialog, BrowserWindow, type MessageBoxOptions } from 'electron'
import { constants, type Stats } from 'node:fs'
import { access, lstat, open, readFile, realpath, stat } from 'node:fs/promises'
import writeFileAtomic from 'write-file-atomic'
import { basename, dirname, resolve } from 'node:path'
import iconv from 'iconv-lite'
import { preferences } from './preferences'

export type FileEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'windows1252'
export type BomlessFileEncoding = 'auto' | 'utf8' | 'windows1252'
export type FileEol = 'LF' | 'CRLF'

export interface FileEolCounts {
  crlf: number
  lf: number
  cr: number
}

export type FileEolKind = 'LF' | 'CRLF' | 'CR' | 'Mixed'

export interface FileEolInfo {
  kind: FileEolKind
  counts: FileEolCounts
}

function eolInfoFromCounts(counts: FileEolCounts): FileEolInfo {
  const forms = Number(counts.crlf > 0) + Number(counts.lf > 0) + Number(counts.cr > 0)

  const kind: FileEolKind =
    forms > 1 ? 'Mixed' : counts.crlf > 0 ? 'CRLF' : counts.cr > 0 ? 'CR' : 'LF'

  return { kind, counts }
}

export type FileBom = 'none' | 'utf8' | 'utf16le' | 'utf16be'

export interface FileInspection {
  filePath: string
  filename: string
  size: number
  modifiedMs: number
  permissions: string
  readOnly: boolean
  symbolicLink: boolean
  symbolicTarget: string | null
  scanEncoding: FileEncoding
  bom: FileBom
  nulBytes: number
  sourceEol: FileEolInfo
  inspectedAtMs: number
}

export const DEFAULT_LARGE_FILE_WARNING_BYTES = 20 * 1024 * 1024
export const SAFE_OPEN_PROBE_BYTES = 8 * 1024
export const FILE_INSPECTION_CHUNK_BYTES = 64 * 1024

export function largeFileWarningBytes(mebibytes: 10 | 20 | 50 | 100): number {
  return mebibytes * 1024 * 1024
}

export interface OpenFileResult {
  filePath: string
  text: string
  encoding: FileEncoding
  eol: FileEol
  sourceEol: FileEolInfo
  readOnly: boolean
  forcedReadOnly: boolean
  size: number
  largeFileMode: boolean
}

interface SaveTarget {
  path: string
  stats: Stats | null
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function resolveSaveTarget(filePath: string): Promise<SaveTarget> {
  try {
    const targetPath = await realpath(filePath)
    return { path: targetPath, stats: await stat(targetPath) }
  } catch (error) {
    if (!isMissingFile(error)) throw error

    const entry = await lstat(filePath).catch((entryError: unknown) => {
      if (!isMissingFile(entryError)) throw entryError
      return null
    })

    // write-file-atomic falls back to replacing the supplied path when realpath
    // fails. Never let that fallback replace a dangling symbolic link.
    if (entry?.isSymbolicLink()) {
      throw new Error('The symbolic link target is missing. Use Save As to save elsewhere.')
    }
    if (entry) throw error

    // A normally opened file may have been deleted; allow safe recreation.
    return { path: resolve(filePath), stats: null }
  }
}

async function assertWritableTarget(target: SaveTarget): Promise<void> {
  if (target.stats) {
    if (!target.stats.isFile()) throw new Error('Only regular files can be saved.')
    // Atomic replacement can otherwise bypass a file's read-only permission bits.
    if ((target.stats.mode & 0o222) === 0) {
      throw new Error('This file is read-only. Use Save As to save your changes elsewhere.')
    }
    await access(target.path, constants.W_OK)
  }

  // Atomic writes need permission to create and rename in the target directory,
  // which may differ from the directory containing an opened symbolic link.
  const directory = dirname(target.path)
  const directoryStats = await stat(directory)
  if ((directoryStats.mode & 0o222) === 0 || (directoryStats.mode & 0o111) === 0) {
    throw new Error('The target directory is read-only. Use Save As to save elsewhere.')
  }
  await access(directory, constants.W_OK | constants.X_OK)
}

export async function getFileReadOnly(filePath: string): Promise<boolean> {
  try {
    await assertWritableTarget(await resolveSaveTarget(filePath))
    return false
  } catch {
    // Informational only: permissions, mounts, ACLs, or the path may change after
    // this check. The save operation still checks and reports actual write errors.
    return true
  }
}

export function detectBomlessUtf16(bytes: Uint8Array): 'utf16le' | 'utf16be' | null {
  const pairs = Math.floor(bytes.length / 2)
  if (pairs < 2) return null

  let evenNuls = 0
  let oddNuls = 0

  for (let i = 0; i < pairs * 2; i += 2) {
    if (bytes[i] === 0) evenNuls++
    if (bytes[i + 1] === 0) oddNuls++
  }

  const evenRatio = evenNuls / pairs
  const oddRatio = oddNuls / pairs

  // Conservative detection for the common BOM-less UTF-16 case where
  // ASCII-range text produces a strong alternating NUL-byte pattern.
  if (oddNuls >= 2 && oddRatio >= 0.3 && evenRatio <= 0.05) return 'utf16le'
  if (evenNuls >= 2 && evenRatio >= 0.3 && oddRatio <= 0.05) return 'utf16be'

  return null
}

function hasUnicodeBom(bytes: Uint8Array): boolean {
  return (
    (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes.length >= 2 &&
      ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))
  )
}

export function isLikelyBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || hasUnicodeBom(bytes) || detectBomlessUtf16(bytes)) {
    return false
  }

  let suspiciousControls = 0

  for (const byte of bytes) {
    // After UTF-16 detection, a NUL byte is a strong binary signal.
    if (byte === 0) return true

    const allowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d

    if ((byte < 0x20 && !allowedWhitespace) || byte === 0x7f) {
      suspiciousControls++
    }
  }

  return suspiciousControls / bytes.length >= 0.1
}

async function readOpenProbe(filePath: string): Promise<Uint8Array> {
  const handle = await open(filePath, 'r')

  try {
    const buffer = Buffer.allocUnsafe(SAFE_OPEN_PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export function decodeTextFile(
  bytes: Uint8Array,
  bomlessEncoding: BomlessFileEncoding = 'auto'
): {
  text: string
  encoding: FileEncoding
} {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      text: new TextDecoder('utf-8').decode(bytes.subarray(3)),
      encoding: 'utf8-bom'
    }
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le').decode(bytes.subarray(2)),
      encoding: 'utf16le'
    }
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: new TextDecoder('utf-16be').decode(bytes.subarray(2)),
      encoding: 'utf16be'
    }
  }

  if (bomlessEncoding === 'auto') {
    const utf16 = detectBomlessUtf16(bytes)
    if (utf16) {
      return {
        text: new TextDecoder(utf16 === 'utf16le' ? 'utf-16le' : 'utf-16be').decode(bytes),
        encoding: utf16
      }
    }
  }

  if (bomlessEncoding === 'windows1252') {
    return {
      text: iconv.decode(Buffer.from(bytes), 'windows-1252'),
      encoding: 'windows1252'
    }
  }

  if (bomlessEncoding === 'auto') {
    try {
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        encoding: 'utf8'
      }
    } catch {
      return {
        text: iconv.decode(Buffer.from(bytes), 'windows-1252'),
        encoding: 'windows1252'
      }
    }
  }

  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf8' }
}

export function decodeTextFileWithEncoding(
  bytes: Uint8Array,
  encoding: FileEncoding
): {
  text: string
  encoding: FileEncoding
} {
  switch (encoding) {
    case 'utf8': {
      const content =
        bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          ? bytes.subarray(3)
          : bytes
      return { text: new TextDecoder('utf-8').decode(content), encoding }
    }

    case 'utf8-bom': {
      const content =
        bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          ? bytes.subarray(3)
          : bytes
      return { text: new TextDecoder('utf-8').decode(content), encoding }
    }

    case 'utf16le': {
      const content =
        bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2) : bytes
      return { text: new TextDecoder('utf-16le').decode(content), encoding }
    }

    case 'utf16be': {
      const content =
        bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? bytes.subarray(2) : bytes
      return { text: new TextDecoder('utf-16be').decode(content), encoding }
    }

    case 'windows1252':
      return {
        text: iconv.decode(Buffer.from(bytes), 'windows-1252'),
        encoding
      }
  }
}

export function analyzeEol(text: string): FileEolInfo {
  let crlf = 0
  let lf = 0
  let cr = 0

  for (let index = 0; index < text.length; index++) {
    const character = text[index]

    if (character === '\r') {
      if (text[index + 1] === '\n') {
        crlf++
        index++
      } else {
        cr++
      }
    } else if (character === '\n') {
      lf++
    }
  }

  return eolInfoFromCounts({ crlf, lf, cr })
}

interface FileInspectionPathState {
  entry: Stats
  target: Stats
  symbolicLink: boolean
  symbolicTarget: string | null
}

interface FileInspectionEolState {
  pendingCr: boolean
}

function fileChangedDuringInspection(): Error {
  return new Error('The file changed during inspection. Refresh and try again.')
}

function sameInspectionStats(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  )
}

async function readInspectionPathState(filePath: string): Promise<FileInspectionPathState> {
  const entry = await lstat(filePath)
  const symbolicLink = entry.isSymbolicLink()
  const symbolicTarget = symbolicLink ? await realpath(filePath) : null
  const target = await stat(filePath)

  return {
    entry,
    target,
    symbolicLink,
    symbolicTarget
  }
}

function assertInspectionPathStable(
  before: FileInspectionPathState,
  after: FileInspectionPathState
): void {
  if (
    before.symbolicLink !== after.symbolicLink ||
    before.symbolicTarget !== after.symbolicTarget ||
    !sameInspectionStats(before.entry, after.entry) ||
    !sameInspectionStats(before.target, after.target)
  ) {
    throw fileChangedDuringInspection()
  }
}

function consumeInspectionEolUnit(
  unit: number,
  counts: FileEolCounts,
  state: FileInspectionEolState
): void {
  if (state.pendingCr) {
    if (unit === 0x0a) {
      counts.crlf++
      state.pendingCr = false
      return
    }

    counts.cr++
    state.pendingCr = false
  }

  if (unit === 0x0d) {
    state.pendingCr = true
  } else if (unit === 0x0a) {
    counts.lf++
  }
}

function finishInspectionEol(counts: FileEolCounts, state: FileInspectionEolState): void {
  if (state.pendingCr) {
    counts.cr++
    state.pendingCr = false
  }
}

function detectFileBom(prefix: readonly number[]): FileBom {
  if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) {
    return 'utf8'
  }

  if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe) {
    return 'utf16le'
  }

  if (prefix.length >= 2 && prefix[0] === 0xfe && prefix[1] === 0xff) {
    return 'utf16be'
  }

  return 'none'
}

function formatFilePermissions(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0')
}

export async function inspectFilePath(
  filePath: string,
  scanEncoding: FileEncoding
): Promise<FileInspection> {
  const before = await readInspectionPathState(filePath)

  if (!before.target.isFile()) {
    throw new Error('Only regular files can be inspected.')
  }

  const counts: FileEolCounts = {
    crlf: 0,
    lf: 0,
    cr: 0
  }
  const eolState: FileInspectionEolState = {
    pendingCr: false
  }
  const prefix: number[] = []

  let nulBytes = 0
  let utf16Carry: number | null = null

  const handle = await open(filePath, 'r')

  try {
    const opened = await handle.stat()

    if (!sameInspectionStats(before.target, opened)) {
      throw fileChangedDuringInspection()
    }

    const buffer = Buffer.allocUnsafe(FILE_INSPECTION_CHUNK_BYTES)

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)

      if (bytesRead === 0) break

      for (let index = 0; index < bytesRead; index++) {
        const byte = buffer[index]

        if (prefix.length < 3) {
          prefix.push(byte)
        }

        if (byte === 0) {
          nulBytes++
        }
      }

      if (scanEncoding === 'utf16le' || scanEncoding === 'utf16be') {
        let index = 0

        if (utf16Carry !== null) {
          const unit =
            scanEncoding === 'utf16le'
              ? utf16Carry | (buffer[0] << 8)
              : (utf16Carry << 8) | buffer[0]

          consumeInspectionEolUnit(unit, counts, eolState)
          utf16Carry = null
          index = 1
        }

        for (; index + 1 < bytesRead; index += 2) {
          const unit =
            scanEncoding === 'utf16le'
              ? buffer[index] | (buffer[index + 1] << 8)
              : (buffer[index] << 8) | buffer[index + 1]

          consumeInspectionEolUnit(unit, counts, eolState)
        }

        if (index < bytesRead) {
          utf16Carry = buffer[index]
        }
      } else {
        for (let index = 0; index < bytesRead; index++) {
          consumeInspectionEolUnit(buffer[index], counts, eolState)
        }
      }
    }

    const scanned = await handle.stat()

    if (!sameInspectionStats(before.target, scanned)) {
      throw fileChangedDuringInspection()
    }
  } finally {
    await handle.close()
  }

  finishInspectionEol(counts, eolState)

  let after: FileInspectionPathState

  try {
    after = await readInspectionPathState(filePath)
  } catch {
    throw fileChangedDuringInspection()
  }

  assertInspectionPathStable(before, after)

  const readOnly = await getFileReadOnly(filePath)

  let finalState: FileInspectionPathState

  try {
    finalState = await readInspectionPathState(filePath)
  } catch {
    throw fileChangedDuringInspection()
  }

  assertInspectionPathStable(before, finalState)

  return {
    filePath,
    filename: basename(filePath),
    size: finalState.target.size,
    modifiedMs: finalState.target.mtimeMs,
    permissions: formatFilePermissions(finalState.target.mode),
    readOnly,
    symbolicLink: finalState.symbolicLink,
    symbolicTarget: finalState.symbolicTarget,
    scanEncoding,
    bom: detectFileBom(prefix),
    nulBytes,
    sourceEol: eolInfoFromCounts(counts),
    inspectedAtMs: Date.now()
  }
}

function modelEolFromSource(sourceEol: FileEolInfo): FileEol {
  // Preserve the current Monaco model-EOL policy for now. Source EOL
  // accounting is deliberately separate from the model's uniform EOL.
  return sourceEol.counts.crlf > 0 ? 'CRLF' : 'LF'
}

export async function openFileDialog(
  window: BrowserWindow,
  bomlessEncoding: BomlessFileEncoding = 'auto'
): Promise<OpenFileResult | null> {
  const lastDirectory = preferences.get('lastDirectory')

  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    ...(lastDirectory ? { defaultPath: lastDirectory } : {})
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const filePath = result.filePaths[0]
  preferences.set('lastDirectory', dirname(filePath))

  return openFilePath(filePath, bomlessEncoding, window)
}

async function readTextFilePath(
  filePath: string,
  decoder: (bytes: Uint8Array) => { text: string; encoding: FileEncoding },
  window?: BrowserWindow
): Promise<OpenFileResult | null> {
  const fileStats = await stat(filePath)
  if (!fileStats.isFile()) throw new Error('Only regular files can be opened.')

  const warningBytes = largeFileWarningBytes(preferences.get('largeFileWarningMiB'))
  if (fileStats.size >= warningBytes) {
    const options: MessageBoxOptions = {
      type: 'warning',
      title: 'Large File',
      message: 'This file is large and may reduce editor performance.',
      detail: `${basename(filePath)} is ${(fileStats.size / (1024 * 1024)).toFixed(1)} MiB. Open anyway?`,
      buttons: ['Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    if (result.response !== 0) return null
  }

  const probe = await readOpenProbe(filePath)
  let forcedReadOnly = false

  if (isLikelyBinary(probe)) {
    const options: MessageBoxOptions = {
      type: 'warning',
      title: 'Likely Binary File',
      message: 'This file appears to contain binary data.',
      detail:
        'Opening it as text may display unreadable characters. Monaco Notepad will lock the document to prevent accidental overwrite.',
      buttons: ['Open Read-Only Anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }

    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)

    if (result.response !== 0) return null
    forcedReadOnly = true
  }

  const bytes = await readFile(filePath)
  const decoded = decoder(bytes)
  const sourceEol = analyzeEol(decoded.text)
  const eol = modelEolFromSource(sourceEol)
  preferences.set('lastDirectory', dirname(filePath))

  return {
    filePath,
    text: decoded.text,
    encoding: decoded.encoding,
    eol,
    sourceEol,
    readOnly: await getFileReadOnly(filePath),
    forcedReadOnly,
    size: fileStats.size,
    largeFileMode: fileStats.size >= warningBytes
  }
}

export async function openFilePath(
  filePath: string,
  bomlessEncoding: BomlessFileEncoding = 'auto',
  window?: BrowserWindow
): Promise<OpenFileResult | null> {
  return readTextFilePath(filePath, (bytes) => decodeTextFile(bytes, bomlessEncoding), window)
}

export async function reopenFilePath(
  filePath: string,
  encoding: FileEncoding,
  window?: BrowserWindow
): Promise<OpenFileResult | null> {
  return readTextFilePath(filePath, (bytes) => decodeTextFileWithEncoding(bytes, encoding), window)
}

export function encodeTextFile(text: string, encoding: FileEncoding): Uint8Array {
  switch (encoding) {
    case 'utf8':
      return Buffer.from(text, 'utf8')

    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])

    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])

    case 'utf16be': {
      const littleEndian = Buffer.from(text, 'utf16le')
      const bigEndian = Buffer.allocUnsafe(littleEndian.length)

      for (let i = 0; i < littleEndian.length; i += 2) {
        bigEndian[i] = littleEndian[i + 1]
        bigEndian[i + 1] = littleEndian[i]
      }

      return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])
    }

    case 'windows1252': {
      const bytes = iconv.encode(text, 'windows-1252')

      if (iconv.decode(bytes, 'windows-1252') !== text) {
        throw new Error(
          'This document contains characters that cannot be represented in ANSI (Windows-1252). Choose a Unicode encoding before saving.'
        )
      }

      return bytes
    }
  }
}

export async function writeTextFileAtomic(
  filePath: string,
  text: string,
  encoding: FileEncoding
): Promise<void> {
  const bytes = encodeTextFile(text, encoding)
  const target = await resolveSaveTarget(filePath)
  await assertWritableTarget(target)

  // Resolve a live symlink before writing so the link itself stays intact.
  // Preserve executable and other permission bits; the library retains uid/gid
  // where permitted and fsyncs the temporary file before atomic replacement.
  await writeFileAtomic(target.path, bytes, {
    ...(target.stats
      ? {
          mode: target.stats.mode,
          chown: { uid: target.stats.uid, gid: target.stats.gid }
        }
      : {})
  })
}

export interface SaveFileRequest {
  filePath: string | null
  text: string
  encoding: FileEncoding
  protectedPath?: string | null
}

export async function saveFile(
  window: BrowserWindow,
  request: SaveFileRequest,
  dialogTitle = 'Save As'
): Promise<string | null> {
  let filePath = request.filePath

  if (!filePath) {
    const lastDirectory = preferences.get('lastDirectory')

    const result = await dialog.showSaveDialog(window, {
      title: dialogTitle,
      ...(lastDirectory ? { defaultPath: lastDirectory } : {})
    })

    if (result.canceled || !result.filePath) {
      return null
    }

    filePath = result.filePath
    preferences.set('lastDirectory', dirname(filePath))
  }

  if (request.protectedPath) {
    const requested = resolve(filePath)
    const protectedResolved = resolve(request.protectedPath)

    let requestedReal = requested
    let protectedReal = protectedResolved

    try {
      requestedReal = await realpath(filePath)
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }

    try {
      protectedReal = await realpath(request.protectedPath)
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }

    if (requested === protectedResolved || requestedReal === protectedReal) {
      throw new Error('Safe Open prevents overwriting the original file. Choose a different path.')
    }
  }

  await writeTextFileAtomic(filePath, request.text, request.encoding)

  return filePath
}
