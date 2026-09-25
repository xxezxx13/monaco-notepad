import Store from 'electron-store'
import type { FileEncoding } from './files'

export interface FilePosition {
  line: number
  column: number
  scrollTop: number
  languageOverride?: string
  accessedAt: number
}

export function getFilePosition(filePath: string): FilePosition | null {
  return preferences.get('filePositions')[filePath] ?? null
}

export function saveFilePosition(filePath: string, position: FilePosition): void {
  const positions = { ...preferences.get('filePositions') }
  positions[filePath] = { ...position }
  const entries = Object.entries(positions)
    .sort((a, b) => b[1].accessedAt - a[1].accessedAt)
    .slice(0, 20)
  preferences.set('filePositions', Object.fromEntries(entries))
}

export interface Preferences {
  wordWrap: boolean
  typewriterScrolling: boolean
  zoomLevel: number
  statusBarVisible: boolean
  showWhitespace: boolean
  showLineNumbers: boolean
  reopenLastDocument: boolean
  lastDocumentPath: string | null
  lastDocumentEncoding: 'auto' | 'utf8' | 'windows1252'
  windowWidth: number
  windowHeight: number
  lastDirectory: string | null
  recentFiles: string[]
  trimTrailingWhitespaceOnSave: boolean
  autoIndent: 'none' | 'full'
  tabSize: 2 | 4 | 8
  insertSpaces: boolean
  largeFileWarningMiB: 10 | 20 | 50 | 100
  theme: 'system' | 'light' | 'dark'
  fontFamily: string
  fontSize: number
  defaultEncoding: FileEncoding
  defaultEol: 'LF' | 'CRLF'
  filePositions: Record<string, FilePosition>
  primarySelectionPaste: boolean
}

export const preferences = new Store<Preferences>({
  defaults: {
    wordWrap: false,
    typewriterScrolling: false,
    zoomLevel: 0,
    statusBarVisible: true,
    showWhitespace: false,
    showLineNumbers: false,
    reopenLastDocument: false,
    lastDocumentPath: null,
    lastDocumentEncoding: 'auto',
    windowWidth: 900,
    windowHeight: 670,
    lastDirectory: null,
    recentFiles: [],
    trimTrailingWhitespaceOnSave: false,
    autoIndent: 'none',
    tabSize: 4,
    insertSpaces: true,
    largeFileWarningMiB: 20,
    theme: 'light',
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: 14,
    defaultEncoding: 'utf8',
    defaultEol: 'LF',
    filePositions: {},
    primarySelectionPaste: true
  }
})
