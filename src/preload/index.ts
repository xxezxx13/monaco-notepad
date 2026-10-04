import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MenuCommand, MenuContextState } from '../shared/commands'
import type { Preferences, FilePosition } from '../main/preferences'

type FileEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'windows1252'
type BomlessFileEncoding = 'auto' | 'utf8' | 'windows1252'

type FileEolInfo = {
  kind: 'LF' | 'CRLF' | 'CR' | 'Mixed'
  counts: {
    crlf: number
    lf: number
    cr: number
  }
}

type FileInspection = {
  filePath: string
  filename: string
  size: number
  modifiedMs: number
  permissions: string
  readOnly: boolean
  symbolicLink: boolean
  symbolicTarget: string | null
  scanEncoding: FileEncoding
  bom: 'none' | 'utf8' | 'utf16le' | 'utf16be'
  nulBytes: number
  sourceEol: FileEolInfo
  inspectedAtMs: number
}

type OpenFileResult = {
  filePath: string
  text: string
  encoding: FileEncoding
  eol: 'LF' | 'CRLF'
  sourceEol: FileEolInfo
  readOnly: boolean
  forcedReadOnly: boolean
  size: number
  largeFileMode: boolean
} | null

type ReopenFileResult =
  | (NonNullable<OpenFileResult> & {
      baselineSignature: string
    })
  | null

type OpenFileProgress = {
  requestId: string
  bytesRead: number
  totalBytes: number
}

type EditorPreferences = {
  trimTrailingWhitespaceOnSave: boolean
  autoIndent: 'none' | 'full'
  tabSize: 2 | 4 | 8
  insertSpaces: boolean
  largeFileWarningMiB: 10 | 20 | 50 | 100
}

type SaveFileRequest = {
  filePath: string | null
  text: string
  encoding: FileEncoding
  baselineCheck?: boolean
  expectedSignature?: string | null
  protectedPath?: string | null
}

type SaveFileResult =
  | { action: 'saved'; filePath: string }
  | { action: 'conflict'; signature: string | null }
  | { action: 'cancelled' }
  | { action: 'error'; message: string }

type UnsavedChoice = 'save' | 'discard' | 'cancel'
type ExternalFileChange = {
  filePath: string
  exists: boolean
  kind: 'modified' | 'replaced' | 'deleted'
  signature: string | null
}
type FollowUpdate =
  | { kind: 'append'; text: string; from: number; to: number }
  | {
      kind: 'reset'
      text: string
      reason: 'truncated' | 'rotated' | 'recreated'
      from: 0
      to: number
    }
  | { kind: 'waiting' }
type RecoveryData = {
  filePath: string | null
  text: string
  encoding: FileEncoding
  eol: 'LF' | 'CRLF'
  sourceEol?: FileEolInfo | null
  eolNormalizationTarget?: 'LF' | 'CRLF' | null
  position?: { line: number; column: number; scrollTop: number; languageOverride?: string }
}

const api = {
  preferences: {
    getAll: (): Promise<Preferences> => ipcRenderer.invoke('preferences:get-all'),
    set: <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
      ipcRenderer.invoke('preferences:set', key, value),
    exportSettings: (): Promise<'exported' | 'canceled'> =>
      ipcRenderer.invoke('preferences:export'),
    importSettings: (): Promise<'imported' | 'canceled' | 'invalid'> =>
      ipcRenderer.invoke('preferences:import')
  },

  getWordWrap: (): Promise<boolean> => ipcRenderer.invoke('preferences:get-word-wrap'),

  getShowWhitespace: (): Promise<boolean> => ipcRenderer.invoke('preferences:get-show-whitespace'),

  getShowLineNumbers: (): Promise<boolean> =>
    ipcRenderer.invoke('preferences:get-show-line-numbers'),

  getStatusBarVisible: (): Promise<boolean> =>
    ipcRenderer.invoke('preferences:get-status-bar-visible'),

  getZoomLevel: (): Promise<number> => ipcRenderer.invoke('preferences:get-zoom-level'),

  setZoomLevel: (zoomLevel: number): Promise<void> =>
    ipcRenderer.invoke('preferences:set-zoom-level', zoomLevel),

  getEditorPreferences: (): Promise<EditorPreferences> =>
    ipcRenderer.invoke('preferences:get-editor'),

  isSessionOwner: (): Promise<boolean> => ipcRenderer.invoke('app:is-session-owner'),

  rendererReady: (recoveryRestored = false): Promise<void> =>
    ipcRenderer.invoke('app:renderer-ready', recoveryRestored),

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  openFile: (encoding: BomlessFileEncoding = 'auto', requestId?: string): Promise<OpenFileResult> =>
    ipcRenderer.invoke('file:open', encoding, requestId),

  openFilePath: (
    filePath: string,
    encoding: BomlessFileEncoding = 'auto',
    requestId?: string
  ): Promise<OpenFileResult> => ipcRenderer.invoke('file:open-path', filePath, encoding, requestId),

  reopenFilePath: (
    filePath: string,
    encoding: FileEncoding,
    requestId?: string
  ): Promise<ReopenFileResult> =>
    ipcRenderer.invoke('file:reopen-with-encoding', filePath, encoding, requestId),

  cancelOpen: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke('file:cancel-open', requestId),

  onOpenProgress: (callback: (progress: OpenFileProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: OpenFileProgress): void =>
      callback(progress)
    ipcRenderer.on('file:open-progress', listener)
    return () => ipcRenderer.removeListener('file:open-progress', listener)
  },

  acceptReopenBaseline: (filePath: string, baselineSignature: string): Promise<void> =>
    ipcRenderer.invoke('file:accept-reopen-baseline', filePath, baselineSignature),

  readDiskForCompare: (
    filePath: string,
    encoding: BomlessFileEncoding,
    requestId?: string
  ): Promise<OpenFileResult> =>
    ipcRenderer.invoke('file:read-for-compare', filePath, encoding, requestId),

  saveFile: (request: SaveFileRequest): Promise<SaveFileResult> =>
    ipcRenderer.invoke('file:save', request),

  saveCopy: (request: SaveFileRequest): Promise<SaveFileResult> =>
    ipcRenderer.invoke('file:save-copy', request),

  printDocument: (request: { title: string; text: string; fontFamily: string }): Promise<void> =>
    ipcRenderer.invoke('file:print', request),

  resolveConflict: (conflict: {
    filePath: string
  }): Promise<'reload' | 'overwrite' | 'save-as' | 'cancel'> =>
    ipcRenderer.invoke('file:resolve-conflict', conflict),

  getFileSize: (filePath: string): Promise<number | null> =>
    ipcRenderer.invoke('file:get-size', filePath),

  copyPath: (filePath: string, filenameOnly = false): Promise<void> =>
    ipcRenderer.invoke('file:copy-path', filePath, filenameOnly),

  revealFile: (filePath: string): Promise<void> => ipcRenderer.invoke('file:reveal', filePath),

  openTerminal: (filePath: string | null): Promise<void> =>
    ipcRenderer.invoke('file:open-terminal', filePath),

  inspectFile: (filePath: string, encoding: FileEncoding): Promise<FileInspection> =>
    ipcRenderer.invoke('file:inspect', filePath, encoding),

  showSha256: (filePath: string, dirty: boolean): Promise<void> =>
    ipcRenderer.invoke('file:sha256', filePath, dirty),

  confirmDiscard: (action: 'reload' | 'revert'): Promise<boolean> =>
    ipcRenderer.invoke('document:confirm-discard', action),

  getFileReadOnly: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('file:get-read-only', filePath),

  getFilePosition: (filePath: string): Promise<FilePosition | null> =>
    ipcRenderer.invoke('file:position:get', filePath),

  saveFilePosition: (filePath: string, position: FilePosition): Promise<void> =>
    ipcRenderer.invoke('file:position:save', filePath, position),

  watchFile: (filePath: string | null): Promise<void> => ipcRenderer.invoke('file:watch', filePath),

  confirmExternalFileChange: (
    change: ExternalFileChange & { dirty: boolean; largeFileMode: boolean }
  ): Promise<'reload' | 'keep' | 'compare' | 'save-as' | 'overwrite'> =>
    ipcRenderer.invoke('file:confirm-external-change', change),

  externalFileChangeHandled: (): Promise<void> =>
    ipcRenderer.invoke('file:external-change-handled'),

  onExternalFileChange: (callback: (change: ExternalFileChange) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: ExternalFileChange): void =>
      callback(change)

    ipcRenderer.on('file:external-change', listener)
    return () => ipcRenderer.removeListener('file:external-change', listener)
  },

  saveRecovery: (recovery: RecoveryData): Promise<void> =>
    ipcRenderer.invoke('recovery:save', recovery),

  clearRecovery: (): Promise<void> => ipcRenderer.invoke('recovery:clear'),

  checkRecovery: (): Promise<RecoveryData | null> => ipcRenderer.invoke('recovery:check'),

  confirmUnsavedChanges: (): Promise<UnsavedChoice> =>
    ipcRenderer.invoke('document:confirm-unsaved'),

  onCloseRequested: (callback: () => void): (() => void) => {
    const listener = (): void => callback()

    ipcRenderer.on('app:close-requested', listener)

    return () => {
      ipcRenderer.removeListener('app:close-requested', listener)
    }
  },

  approveClose: (): Promise<void> => ipcRenderer.invoke('app:close-approved'),

  onOpenFileRequested: (
    callback: (filePath: string, encoding?: BomlessFileEncoding) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      filePath: string,
      encoding?: BomlessFileEncoding
    ): void => callback(filePath, encoding)

    ipcRenderer.on('app:open-file-requested', listener)
    return () => ipcRenderer.removeListener('app:open-file-requested', listener)
  },

  onStatusBar: (callback: (visible: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, visible: boolean): void =>
      callback(visible)

    ipcRenderer.on('menu:status-bar', listener)

    return () => {
      ipcRenderer.removeListener('menu:status-bar', listener)
    }
  },

  onWordWrap: (callback: (enabled: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean): void =>
      callback(enabled)

    ipcRenderer.on('menu:word-wrap', listener)

    return () => {
      ipcRenderer.removeListener('menu:word-wrap', listener)
    }
  },

  onTypewriterScrolling: (callback: (enabled: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean): void =>
      callback(enabled)

    ipcRenderer.on('menu:typewriter-scrolling', listener)

    return () => {
      ipcRenderer.removeListener('menu:typewriter-scrolling', listener)
    }
  },

  onShowWhitespace: (callback: (enabled: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean): void =>
      callback(enabled)

    ipcRenderer.on('menu:show-whitespace', listener)
    return () => ipcRenderer.removeListener('menu:show-whitespace', listener)
  },

  onShowLineNumbers: (callback: (enabled: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean): void =>
      callback(enabled)

    ipcRenderer.on('menu:show-line-numbers', listener)
    return () => ipcRenderer.removeListener('menu:show-line-numbers', listener)
  },

  onEditorPreferences: (callback: (preferences: EditorPreferences) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, preferences: EditorPreferences): void =>
      callback(preferences)
    ipcRenderer.on('menu:editor-preferences', listener)
    return () => ipcRenderer.removeListener('menu:editor-preferences', listener)
  },

  onPreferencesChanged: (callback: (changes: Partial<Preferences>) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, changes: Partial<Preferences>): void =>
      callback(changes)
    ipcRenderer.on('preferences:changed', listener)
    return () => {
      ipcRenderer.removeListener('preferences:changed', listener)
    }
  },

  onPreferencesImported: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('preferences:imported', listener)
    return () => ipcRenderer.removeListener('preferences:imported', listener)
  },

  onSystemThemeChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('theme:system-changed', listener)
    return () => {
      ipcRenderer.removeListener('theme:system-changed', listener)
    }
  },

  onPortalThemeChanged: (callback: (theme: 'light' | 'dark' | null) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark' | null): void =>
      callback(theme)
    ipcRenderer.on('theme:portal-changed', listener)
    return () => ipcRenderer.removeListener('theme:portal-changed', listener)
  },

  openPreferencesDialog: (): Promise<void> => ipcRenderer.invoke('preferences:open-dialog'),

  getPrimarySelection: (): Promise<string> => ipcRenderer.invoke('linux:primary-selection:get'),

  setPrimarySelection: (text: string): Promise<void> =>
    ipcRenderer.invoke('linux:primary-selection:set', text),

  writeClipboardText: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:write-text', text),

  hashSelections: (algorithm: 'sha256' | 'sha1' | 'md5', selections: string[]): Promise<string[]> =>
    ipcRenderer.invoke('selection:hash-copy', algorithm, selections),

  startFollow: (filePath: string, encoding: FileEncoding): Promise<{ size: number }> =>
    ipcRenderer.invoke('file:follow-start', filePath, encoding),

  stopFollow: (): Promise<void> => ipcRenderer.invoke('file:follow-stop'),

  setMenuContextState: (state: MenuContextState): Promise<void> =>
    ipcRenderer.invoke('menu:context-state', state),

  onFollowUpdate: (callback: (update: FollowUpdate) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: FollowUpdate): void =>
      callback(update)
    ipcRenderer.on('file:follow-update', listener)
    return () => ipcRenderer.removeListener('file:follow-update', listener)
  },

  onFollowError: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string): void => callback(message)
    ipcRenderer.on('file:follow-error', listener)
    return () => ipcRenderer.removeListener('file:follow-error', listener)
  },

  onFullScreen: (callback: (enabled: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean): void =>
      callback(enabled)
    ipcRenderer.on('window:full-screen', listener)
    return () => ipcRenderer.removeListener('window:full-screen', listener)
  },

  onMenuCommand: (callback: (command: MenuCommand) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: MenuCommand): void =>
      callback(command)

    ipcRenderer.on('menu:command', listener)

    return () => {
      ipcRenderer.removeListener('menu:command', listener)
    }
  }
}

export type AppApi = typeof api

contextBridge.exposeInMainWorld('api', api)
