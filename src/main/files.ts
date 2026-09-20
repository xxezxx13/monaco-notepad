import { dialog, BrowserWindow, type MessageBoxOptions } from 'electron'
import { constants, type Stats } from 'node:fs'
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises'
import writeFileAtomic from 'write-file-atomic'
import { basename, dirname, resolve } from 'node:path'
import iconv from 'iconv-lite'
import { preferences } from './preferences'

export type FileEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'windows1252'
export type BomlessFileEncoding = 'auto' | 'utf8' | 'windows1252'
export type FileEol = 'LF' | 'CRLF'
export const DEFAULT_LARGE_FILE_WARNING_BYTES = 20 * 1024 * 1024

export function largeFileWarningBytes(mebibytes: 10 | 20 | 50 | 100): number {
  return mebibytes * 1024 * 1024
}

export interface OpenFileResult {
  filePath: string
  text: string
  encoding: FileEncoding
  eol: FileEol
  readOnly: boolean
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

function detectEol(text: string): FileEol {
  return text.includes('\r\n') ? 'CRLF' : 'LF'
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

export async function openFilePath(
  filePath: string,
  bomlessEncoding: BomlessFileEncoding = 'auto',
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

  const bytes = await readFile(filePath)
  const decoded = decodeTextFile(bytes, bomlessEncoding)
  const eol = detectEol(decoded.text)
  preferences.set('lastDirectory', dirname(filePath))

  return {
    filePath,
    text: decoded.text,
    encoding: decoded.encoding,
    eol,
    readOnly: await getFileReadOnly(filePath),
    size: fileStats.size,
    largeFileMode: fileStats.size >= warningBytes
  }
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

  await writeTextFileAtomic(filePath, request.text, request.encoding)

  return filePath
}
