import { app, shell, BrowserWindow, ipcMain, dialog, nativeTheme, clipboard } from 'electron'
import { isAbsolute, join, resolve } from 'path'
import { basename, dirname } from 'node:path'
import { realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
import { readFile, unlink, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import writeFileAtomic from 'write-file-atomic'
import { optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  openFileDialog,
  openFilePath,
  reopenFilePath,
  saveFile,
  getFileReadOnly,
  inspectFilePath,
  type BomlessFileEncoding,
  type FileEncoding,
  type SaveFileRequest
} from './files'
import { createSaveBaselineTracker, fileSignature, type ConflictChoice } from './conflict'
import { FollowReader } from './follow'
import { portalThemeFromOutput, type PortalTheme } from './portal'
import { selectionDigests, type SelectionHashAlgorithm } from './selection-hash'
import { installMenu, recordRecentFile, setFollowMenuState } from './menu'
import {
  preferences,
  getFilePosition,
  saveFilePosition,
  type Preferences,
  type FilePosition
} from './preferences'

const approvedCloseWindows = new WeakSet<BrowserWindow>()
let mainWindow: BrowserWindow | null = null
let preferencesWindow: BrowserWindow | null = null
let pendingFilePath: string | null = null
const saveBaseline = createSaveBaselineTracker()
let watchedFilePath: string | null = null
let watchedFileSignature: string | null = null
let fileWatchers: FSWatcher[] = []
let fileWatchTimer: NodeJS.Timeout | null = null
let externalChangePending = false
let pendingFileSignature: string | null = null
let savesInProgress = 0
let rendererReady = false
let recoveryErrorShown = false
let recoveryWrite: Promise<void> = Promise.resolve()
let portalMonitor: ReturnType<typeof spawn> | null = null
let followReader: FollowReader | null = null
let followPoll: Promise<void> = Promise.resolve()

function sendPortalTheme(theme: PortalTheme): void {
  if (preferences.get('theme') === 'system' && mainWindow) {
    mainWindow.webContents.send('theme:portal-changed', theme)
  }
}

function startPortalThemeMonitor(): void {
  if (process.platform !== 'linux') return
  if (portalMonitor) return
  const args = [
    'monitor',
    '--session',
    '--dest',
    'org.freedesktop.portal.Desktop',
    '--object-path',
    '/org/freedesktop/portal/desktop'
  ]
  try {
    const monitor = spawn('gdbus', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    portalMonitor = monitor
    monitor.stdout?.on('data', (chunk: Buffer) => {
      const output = chunk.toString()
      if (output.includes('SettingChanged') && output.includes('color-scheme')) {
        sendPortalTheme(portalThemeFromOutput(output))
      }
    })
    monitor.once('error', () => {
      if (portalMonitor === monitor) portalMonitor = null
    })
    monitor.once('close', () => {
      if (portalMonitor === monitor) portalMonitor = null
    })
  } catch {
    portalMonitor = null
  }
}

function stopPortalThemeMonitor(): void {
  const monitor = portalMonitor
  portalMonitor = null
  if (monitor) monitor.kill()
}

function queryPortalTheme(): void {
  if (process.platform !== 'linux') return
  try {
    const query = spawn(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.portal.Desktop',
        '--object-path',
        '/org/freedesktop/portal/desktop',
        '--method',
        'org.freedesktop.portal.Settings.Read',
        'org.freedesktop.appearance',
        'color-scheme'
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    let output = ''
    query.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    query.once('close', (code) => {
      if (code === 0) sendPortalTheme(portalThemeFromOutput(output))
    })
  } catch {
    // Electron's native theme remains the fallback.
  }
}

type RecoveryEolInfo = {
  kind: 'LF' | 'CRLF' | 'CR' | 'Mixed'
  counts: {
    crlf: number
    lf: number
    cr: number
  }
}

type RecoveryData = {
  filePath: string | null
  text: string
  encoding: FileEncoding
  eol: 'LF' | 'CRLF'
  sourceEol?: RecoveryEolInfo | null
  eolNormalizationTarget?: 'LF' | 'CRLF' | null
  position?: { line: number; column: number; scrollTop: number; languageOverride?: string }
}

function recoveryFilePath(): string {
  return join(app.getPath('userData'), 'recovery.json')
}

async function clearRecovery(): Promise<void> {
  await recoveryWrite
  try {
    await unlink(recoveryFilePath())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function isRecoveryEolInfo(value: unknown): value is RecoveryEolInfo {
  if (!value || typeof value !== 'object') return false

  const info = value as Partial<RecoveryEolInfo>
  const counts = info.counts as Partial<RecoveryEolInfo['counts']> | undefined

  return (
    ['LF', 'CRLF', 'CR', 'Mixed'].includes(info.kind ?? '') &&
    counts !== undefined &&
    typeof counts.crlf === 'number' &&
    Number.isInteger(counts.crlf) &&
    counts.crlf >= 0 &&
    typeof counts.lf === 'number' &&
    Number.isInteger(counts.lf) &&
    counts.lf >= 0 &&
    typeof counts.cr === 'number' &&
    Number.isInteger(counts.cr) &&
    counts.cr >= 0
  )
}

function isRecoveryData(value: unknown): value is RecoveryData {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<RecoveryData>
  return (
    (data.filePath === null || typeof data.filePath === 'string') &&
    typeof data.text === 'string' &&
    ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'windows1252'].includes(data.encoding ?? '') &&
    (data.eol === 'LF' || data.eol === 'CRLF') &&
    (data.sourceEol === undefined ||
      data.sourceEol === null ||
      isRecoveryEolInfo(data.sourceEol)) &&
    (data.eolNormalizationTarget === undefined ||
      data.eolNormalizationTarget === null ||
      data.eolNormalizationTarget === 'LF' ||
      data.eolNormalizationTarget === 'CRLF') &&
    (data.position === undefined ||
      (typeof data.position === 'object' &&
        data.position !== null &&
        typeof data.position.line === 'number' &&
        typeof data.position.column === 'number' &&
        typeof data.position.scrollTop === 'number'))
  )
}

async function reportRecoveryError(
  window: BrowserWindow,
  message: string,
  error: unknown
): Promise<void> {
  if (recoveryErrorShown) return
  recoveryErrorShown = true
  const detail = error instanceof Error ? error.message : String(error)
  await dialog.showMessageBox(window, {
    type: 'error',
    title: 'Recovery Error',
    message,
    detail,
    buttons: ['OK']
  })
}

function stopWatchingFile(): void {
  if (fileWatchTimer) clearTimeout(fileWatchTimer)
  fileWatchTimer = null
  for (const watcher of fileWatchers) watcher.close()
  fileWatchers = []
  watchedFilePath = null
  watchedFileSignature = null
  externalChangePending = false
  pendingFileSignature = null
}

function checkWatchedFile(window: BrowserWindow): void {
  if (!watchedFilePath || externalChangePending || savesInProgress > 0) return

  if (followReader?.filePath === watchedFilePath) {
    followPoll = followPoll
      .then(async () => {
        if (!followReader || followReader.filePath !== watchedFilePath) return
        const updates = await followReader.poll()
        for (const update of updates) window.webContents.send('file:follow-update', update)
        watchedFileSignature = fileSignature(watchedFilePath)
      })
      .catch((error) => {
        window.webContents.send(
          'file:follow-error',
          error instanceof Error ? error.message : String(error)
        )
      })
    return
  }

  const signature = fileSignature(watchedFilePath)
  if (signature === watchedFileSignature) return

  externalChangePending = true
  pendingFileSignature = signature
  window.webContents.send('file:external-change', {
    filePath: watchedFilePath,
    exists: signature !== null
  })
}

function watchFile(window: BrowserWindow, filePath: string | null): void {
  stopWatchingFile()
  if (!filePath) return

  watchedFilePath = filePath
  watchedFileSignature = fileSignature(filePath)

  watchFileDirectories(window, filePath)
}

function watchFileDirectories(window: BrowserWindow, filePath: string): void {
  for (const watcher of fileWatchers) watcher.close()
  fileWatchers = []

  // Watch directories, since atomic replacements invalidate inode-based watches.
  // A symlink and its target may live in different directories.
  const paths = new Set([filePath])
  try {
    paths.add(realpathSync(filePath))
  } catch {
    // Keep watching the requested name so deletion/recreation is still detected.
  }
  const directories = new Map<string, Set<string>>()
  for (const path of paths) {
    const directory = dirname(path)
    const names = directories.get(directory) ?? new Set<string>()
    names.add(basename(path))
    directories.set(directory, names)
  }

  try {
    for (const [directory, names] of directories) {
      const watcher = watch(directory, (_eventType, changedName) => {
        if (changedName && !names.has(changedName.toString())) return

        if (fileWatchTimer) clearTimeout(fileWatchTimer)
        fileWatchTimer = setTimeout(() => checkWatchedFile(window), 150)
      })

      fileWatchers.push(watcher)
      watcher.on('error', (error) => {
        stopWatchingFile()
        void dialog.showMessageBox(window, {
          type: 'warning',
          title: 'File Monitoring Error',
          message: 'Monaco Notepad can no longer monitor this file for external changes.',
          detail: error.message,
          buttons: ['OK']
        })
      })
    }
  } catch (error) {
    stopWatchingFile()
    const detail = error instanceof Error ? error.message : String(error)
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: 'File Monitoring Error',
      message: 'Monaco Notepad could not monitor this file for external changes.',
      detail,
      buttons: ['OK']
    })
  }
}

function filePathFromArguments(argv: string[], workingDirectory = process.cwd()): string | null {
  const start = app.isPackaged ? 1 : 2

  for (const argument of argv.slice(start)) {
    if (argument.startsWith('-')) continue
    return isAbsolute(argument) ? argument : resolve(workingDirectory, argument)
  }

  return null
}

function requestFileOpen(filePath: string): void {
  pendingFilePath = filePath

  if (!mainWindow || mainWindow.isDestroyed()) return

  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()

  if (!mainWindow.webContents.isLoading() && rendererReady) {
    pendingFilePath = null
    mainWindow.webContents.send('app:open-file-requested', filePath)
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

// Let Chromium choose Wayland when it is available, while retaining X11/XWayland fallback.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  pendingFilePath = filePathFromArguments(process.argv)

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const filePath = filePathFromArguments(argv, workingDirectory)
    if (filePath) requestFileOpen(filePath)
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function createPreferencesWindow(): void {
  if (preferencesWindow) {
    preferencesWindow.show()
    preferencesWindow.focus()
    return
  }

  preferencesWindow = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 400,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    darkTheme: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  preferencesWindow.on('ready-to-show', () => {
    preferencesWindow?.show()
  })

  preferencesWindow.on('closed', () => {
    preferencesWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    preferencesWindow.loadURL(
      `${process.env['ELECTRON_RENDERER_URL']}/preferences/preferences.html`
    )
  } else {
    preferencesWindow.loadFile(join(__dirname, '../renderer/preferences/preferences.html'))
  }
}

function createWindow(): void {
  // Create the browser window.
  rendererReady = false
  mainWindow = new BrowserWindow({
    width: preferences.get('windowWidth'),
    height: preferences.get('windowHeight'),
    minWidth: 400,
    minHeight: 250,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: '#ffffff',
    darkTheme: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('focus', () => {
    if (mainWindow) checkWatchedFile(mainWindow)
  })

  mainWindow.on('resize', () => {
    if (!mainWindow) return
    const [width, height] = mainWindow.getSize()
    preferences.set('windowWidth', width)
    preferences.set('windowHeight', height)
  })

  mainWindow.on('close', (event) => {
    if (!mainWindow) return
    if (approvedCloseWindows.has(mainWindow)) {
      approvedCloseWindows.delete(mainWindow)
      return
    }

    event.preventDefault()
    mainWindow.webContents.send('app:close-requested')
  })

  mainWindow.on('closed', () => {
    stopWatchingFile()
    rendererReady = false
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  installMenu(mainWindow)

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.once('will-quit', stopPortalThemeMonitor)
process.once('exit', stopPortalThemeMonitor)

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return

  nativeTheme.themeSource = preferences.get('theme')

  nativeTheme.on('updated', () => {
    if (preferences.get('theme') === 'system' && mainWindow) {
      mainWindow.webContents.send('theme:system-changed')
    }
  })
  queryPortalTheme()
  startPortalThemeMonitor()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('preferences:get-all', () => ({
    wordWrap: preferences.get('wordWrap'),
    zoomLevel: preferences.get('zoomLevel'),
    statusBarVisible: preferences.get('statusBarVisible'),
    showWhitespace: preferences.get('showWhitespace'),
    showLineNumbers: preferences.get('showLineNumbers'),
    reopenLastDocument: preferences.get('reopenLastDocument'),
    lastDocumentPath: preferences.get('lastDocumentPath'),
    lastDocumentEncoding: preferences.get('lastDocumentEncoding'),
    windowWidth: preferences.get('windowWidth'),
    windowHeight: preferences.get('windowHeight'),
    lastDirectory: preferences.get('lastDirectory'),
    recentFiles: preferences.get('recentFiles'),
    trimTrailingWhitespaceOnSave: preferences.get('trimTrailingWhitespaceOnSave'),
    autoIndent: preferences.get('autoIndent'),
    tabSize: preferences.get('tabSize'),
    insertSpaces: preferences.get('insertSpaces'),
    largeFileWarningMiB: preferences.get('largeFileWarningMiB'),
    theme: preferences.get('theme'),
    fontFamily: preferences.get('fontFamily'),
    fontSize: preferences.get('fontSize'),
    defaultEncoding: preferences.get('defaultEncoding'),
    defaultEol: preferences.get('defaultEol'),
    filePositions: preferences.get('filePositions'),
    primarySelectionPaste: preferences.get('primarySelectionPaste')
  }))

  ipcMain.handle('preferences:set', (_event, key: keyof Preferences, value: unknown) => {
    preferences.set(key, value)
    if (mainWindow) {
      mainWindow.webContents.send('preferences:changed', { [key]: value })
    }
    if (preferencesWindow) {
      preferencesWindow.webContents.send('preferences:changed', { [key]: value })
    }
    const menuKeys: (keyof Preferences)[] = [
      'wordWrap',
      'showWhitespace',
      'showLineNumbers',
      'statusBarVisible',
      'reopenLastDocument',
      'tabSize',
      'insertSpaces',
      'autoIndent',
      'trimTrailingWhitespaceOnSave',
      'largeFileWarningMiB'
    ]
    if (menuKeys.includes(key)) {
      installMenu(mainWindow!)
    }
  })

  ipcMain.handle('preferences:open-dialog', () => {
    createPreferencesWindow()
  })

  ipcMain.handle('linux:primary-selection:get', () => {
    if (process.platform !== 'linux') return ''
    try {
      return clipboard.readText('selection')
    } catch {
      return ''
    }
  })

  ipcMain.handle('linux:primary-selection:set', (_event, text: string) => {
    if (process.platform !== 'linux' || typeof text !== 'string') return
    try {
      clipboard.writeText(text, 'selection')
    } catch {
      // Some Wayland/XWayland sessions do not expose PRIMARY; regular clipboard remains untouched.
    }
  })

  ipcMain.handle('clipboard:write-text', (_event, text: string) => {
    if (typeof text !== 'string') throw new Error('Invalid clipboard text')
    clipboard.writeText(text)
  })

  ipcMain.handle(
    'selection:hash-copy',
    (_event, algorithm: SelectionHashAlgorithm, selections: string[]) => {
      if (
        !Array.isArray(selections) ||
        selections.some((selection) => typeof selection !== 'string')
      ) {
        throw new Error('Invalid selections')
      }
      const digests = selectionDigests(algorithm, selections)
      clipboard.writeText(digests.join('\n'))
      return digests
    }
  )

  ipcMain.handle('preferences:get-word-wrap', () => {
    return preferences.get('wordWrap')
  })

  ipcMain.handle('preferences:get-show-whitespace', () => preferences.get('showWhitespace'))
  ipcMain.handle('preferences:get-show-line-numbers', () => preferences.get('showLineNumbers'))

  ipcMain.handle('preferences:get-status-bar-visible', () => {
    return preferences.get('statusBarVisible')
  })

  ipcMain.handle('preferences:get-zoom-level', () => {
    return preferences.get('zoomLevel')
  })

  ipcMain.handle('preferences:set-zoom-level', (_event, zoomLevel: number) => {
    preferences.set('zoomLevel', zoomLevel)
  })

  ipcMain.handle('preferences:get-editor', () => ({
    trimTrailingWhitespaceOnSave: preferences.get('trimTrailingWhitespaceOnSave'),
    autoIndent: preferences.get('autoIndent'),
    tabSize: preferences.get('tabSize'),
    insertSpaces: preferences.get('insertSpaces'),
    largeFileWarningMiB: preferences.get('largeFileWarningMiB')
  }))

  ipcMain.handle('app:renderer-ready', (event, recoveryRestored = false) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')

    rendererReady = true
    if (pendingFilePath) {
      const filePath = pendingFilePath
      pendingFilePath = null
      window.webContents.send('app:open-file-requested', filePath)
    } else if (!recoveryRestored && preferences.get('reopenLastDocument')) {
      const filePath = preferences.get('lastDocumentPath')
      if (filePath) {
        try {
          if (!statSync(filePath).isFile()) throw new Error('Not a regular file')
          window.webContents.send(
            'app:open-file-requested',
            filePath,
            preferences.get('lastDocumentEncoding')
          )
        } catch {
          preferences.set('lastDocumentPath', null)
          preferences.set('lastDocumentEncoding', 'auto')
        }
      }
    }
  })

  ipcMain.handle('file:open', async (event, bomlessEncoding: BomlessFileEncoding = 'auto') => {
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window) {
      throw new Error('Unable to resolve application window')
    }

    try {
      const result = await openFileDialog(window, bomlessEncoding)
      if (result) {
        saveBaseline.record(result.filePath)
        recordRecentFile(
          window,
          result.filePath,
          result.encoding === 'windows1252' ? 'windows1252' : 'auto'
        )
      }
      return result
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)

      await dialog.showMessageBox(window, {
        type: 'error',
        title: 'Open Error',
        message: 'The file could not be opened.',
        detail,
        buttons: ['OK']
      })

      return null
    }
  })

  ipcMain.handle(
    'file:open-path',
    async (event, filePath: string, bomlessEncoding: BomlessFileEncoding = 'auto') => {
      const window = BrowserWindow.fromWebContents(event.sender)

      if (!window) throw new Error('Unable to resolve application window')

      try {
        const result = await openFilePath(filePath, bomlessEncoding, window)
        if (result) {
          saveBaseline.record(result.filePath)
          recordRecentFile(
            window,
            result.filePath,
            result.encoding === 'windows1252' ? 'windows1252' : 'auto'
          )
        }
        return result
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        await dialog.showMessageBox(window, {
          type: 'error',
          title: 'Open Error',
          message: 'The file could not be opened.',
          detail,
          buttons: ['OK']
        })
        return null
      }
    }
  )

  ipcMain.handle(
    'file:reopen-with-encoding',
    async (event, filePath: string, encoding: FileEncoding) => {
      const window = BrowserWindow.fromWebContents(event.sender)

      if (!window) throw new Error('Unable to resolve application window')

      try {
        if (!['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'windows1252'].includes(encoding)) {
          throw new Error('Unsupported file encoding')
        }

        const signatureBefore = fileSignature(filePath)
        if (signatureBefore === null) {
          throw new Error('The file could not be identified before reopening.')
        }

        const result = await reopenFilePath(filePath, encoding, window)
        if (!result) return null

        const baselineSignature = fileSignature(result.filePath)
        if (baselineSignature === null || baselineSignature !== signatureBefore) {
          throw new Error('The file changed while it was being reopened. Try again.')
        }

        return { ...result, baselineSignature }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)

        await dialog.showMessageBox(window, {
          type: 'error',
          title: 'Reopen Error',
          message: 'The file could not be reopened with the selected encoding.',
          detail,
          buttons: ['OK']
        })

        return null
      }
    }
  )

  ipcMain.handle(
    'file:accept-reopen-baseline',
    (_event, filePath: string, baselineSignature: string) => {
      if (
        typeof filePath !== 'string' ||
        filePath.length === 0 ||
        typeof baselineSignature !== 'string' ||
        baselineSignature.length === 0
      ) {
        throw new Error('Invalid reopen baseline')
      }

      saveBaseline.recordSignature(filePath, baselineSignature)
    }
  )

  ipcMain.handle(
    'file:read-for-compare',
    async (event, filePath: string, bomlessEncoding: BomlessFileEncoding) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unable to resolve application window')
      try {
        return await openFilePath(filePath, bomlessEncoding, window)
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(
    'file:save',
    async (
      event,
      request: SaveFileRequest & { baselineCheck?: boolean }
    ): Promise<
      | { action: 'saved'; filePath: string }
      | { action: 'conflict' }
      | { action: 'cancelled' }
      | { action: 'error'; message: string }
    > => {
      const window = BrowserWindow.fromWebContents(event.sender)

      if (!window) {
        throw new Error('Unable to resolve application window')
      }

      if (
        request.baselineCheck !== false &&
        request.filePath &&
        saveBaseline.check(request.filePath)
      ) {
        return { action: 'conflict' }
      }

      savesInProgress++
      try {
        const filePath = await saveFile(window, request)
        if (filePath) {
          saveBaseline.record(filePath)
          watchFile(window, filePath)
          recordRecentFile(
            window,
            filePath,
            request.encoding === 'windows1252' ? 'windows1252' : 'auto'
          )
          return { action: 'saved', filePath }
        }
        return { action: 'cancelled' }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)

        await dialog.showMessageBox(window, {
          type: 'error',
          title: 'Save Error',
          message: 'The file could not be saved.',
          detail,
          buttons: ['OK']
        })

        return { action: 'error', message: detail }
      } finally {
        savesInProgress--
        checkWatchedFile(window)
      }
    }
  )

  ipcMain.handle(
    'file:resolve-conflict',
    async (event, { filePath }: { filePath: string }): Promise<ConflictChoice> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unable to resolve application window')

      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'File Changed on Disk',
        message: `Another program has changed ${basename(filePath)}.`,
        detail: 'What would you like to do?',
        buttons: ['Reload', 'Overwrite', 'Save As', 'Cancel'],
        defaultId: 3,
        cancelId: 3,
        noLink: true
      })

      const actions: ConflictChoice[] = ['reload', 'overwrite', 'save-as', 'cancel']
      return actions[result.response]
    }
  )

  ipcMain.handle(
    'file:save-copy',
    async (
      event,
      request: SaveFileRequest
    ): Promise<
      | { action: 'saved'; filePath: string }
      | { action: 'cancelled' }
      | { action: 'error'; message: string }
    > => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unable to resolve application window')
      try {
        const filePath = await saveFile(window, { ...request, filePath: null }, 'Save a Copy')
        if (filePath) {
          return { action: 'saved', filePath }
        }
        return { action: 'cancelled' }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        await dialog.showMessageBox(window, {
          type: 'error',
          title: 'Save Copy Error',
          message: 'The copy could not be saved.',
          detail,
          buttons: ['OK']
        })
        return { action: 'error', message: detail }
      }
    }
  )

  ipcMain.handle(
    'file:print',
    async (
      _event,
      { title, text, fontFamily }: { title: string; text: string; fontFamily: string }
    ) => {
      const printWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      const escapeHtml = (value: string): string =>
        value.replace(/[&<>"']/g, (character) => {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!
        })
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>@media print { body { margin: 1in; font-family: ${escapeHtml(fontFamily)}, monospace; font-size: 12pt; color: #000; background: #fff; white-space: pre-wrap; overflow-wrap: break-word; } }</style>
</head><body>${escapeHtml(text)}</body></html>`

      try {
        await printWindow.loadURL(`data:text/html,${encodeURIComponent(html)}`)
        await new Promise<void>((resolvePrint) => {
          printWindow.webContents.print({ silent: false }, () => resolvePrint())
        })
      } finally {
        if (!printWindow.isDestroyed()) printWindow.close()
      }
    }
  )

  ipcMain.handle('file:get-size', async (_event, filePath: string) => {
    try {
      return (await stat(filePath)).size
    } catch {
      return null
    }
  })

  ipcMain.handle('file:copy-path', (_event, filePath: string, filenameOnly: boolean) => {
    clipboard.writeText(filenameOnly ? basename(filePath) : filePath)
  })

  ipcMain.handle('file:reveal', (_event, filePath: string) => shell.showItemInFolder(filePath))

  ipcMain.handle('file:open-terminal', async (event, filePath: string | null) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    const directory = filePath ? dirname(filePath) : app.getPath('home')
    const candidates: Array<[string, string[]]> = [
      ['x-terminal-emulator', []],
      ['gnome-terminal', ['--working-directory', directory]],
      ['konsole', ['--workdir', directory]],
      ['xfce4-terminal', ['--working-directory', directory]],
      ['kitty', ['--directory', directory]],
      ['alacritty', ['--working-directory', directory]]
    ]
    for (const [command, args] of candidates) {
      const launched = await new Promise<boolean>((resolveLaunch) => {
        const child = spawn(command, args, { cwd: directory, detached: true, stdio: 'ignore' })
        child.once('error', () => resolveLaunch(false))
        child.once('spawn', () => {
          child.unref()
          resolveLaunch(true)
        })
      })
      if (launched) return
    }
    await dialog.showMessageBox(window, {
      type: 'error',
      title: 'Open Terminal Error',
      message: 'No supported external terminal emulator could be launched.',
      detail: directory,
      buttons: ['OK']
    })
  })

  ipcMain.handle('file:inspect', (_event, filePath: string, encoding: FileEncoding) => {
    if (typeof filePath !== 'string' || filePath.length === 0 || !isAbsolute(filePath)) {
      throw new Error('Invalid file path')
    }

    if (!['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'windows1252'].includes(encoding)) {
      throw new Error('Unsupported file encoding')
    }

    return inspectFilePath(filePath, encoding)
  })

  ipcMain.handle('file:sha256', async (event, filePath: string, dirty: boolean) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    try {
      const digest = createHash('sha256')
        .update(await readFile(filePath))
        .digest('hex')
      const result = await dialog.showMessageBox(window, {
        type: 'info',
        title: 'SHA-256',
        message: digest,
        detail: `${basename(filePath)}${dirty ? '\nChecksum is for the saved file on disk; unsaved edits are not included.' : ''}`,
        buttons: ['Copy', 'Close'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      if (result.response === 0) clipboard.writeText(digest)
    } catch (error) {
      await dialog.showMessageBox(window, {
        type: 'error',
        title: 'SHA-256 Error',
        message: 'The saved file could not be hashed.',
        detail: error instanceof Error ? error.message : String(error),
        buttons: ['OK']
      })
    }
  })

  ipcMain.handle('document:confirm-discard', async (event, action: 'reload' | 'revert') => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    const label = action === 'revert' ? 'Revert' : 'Reload'
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: `${label} from Disk`,
      message: `${label} and discard unsaved changes?`,
      buttons: [label, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    return result.response === 0
  })

  ipcMain.handle('file:get-read-only', (_event, filePath: string) => getFileReadOnly(filePath))

  ipcMain.handle('file:position:get', (_event, filePath: string) =>
    getFilePosition(resolve(filePath))
  )

  ipcMain.handle('file:position:save', (_event, filePath: string, position: FilePosition) => {
    saveFilePosition(resolve(filePath), position)
  })

  ipcMain.handle('file:watch', (event, filePath: string | null) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    watchFile(window, filePath)
  })

  ipcMain.handle(
    'file:follow-start',
    async (event, filePath: string, encoding: FileEncoding): Promise<{ size: number }> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unable to resolve application window')
      if (!['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'windows1252'].includes(encoding)) {
        throw new Error('Unsupported file encoding')
      }
      followReader = await FollowReader.create(resolve(filePath), encoding)
      externalChangePending = false
      pendingFileSignature = null
      watchedFileSignature = fileSignature(followReader.filePath)
      return { size: followReader.consumedBytes }
    }
  )

  ipcMain.handle('file:follow-stop', async () => {
    await followPoll
    followReader = null
    externalChangePending = false
    pendingFileSignature = null
    if (watchedFilePath) watchedFileSignature = fileSignature(watchedFilePath)
  })

  ipcMain.handle(
    'file:follow-menu-state',
    (_event, state: { checked: boolean; enabled: boolean }) => {
      setFollowMenuState(Boolean(state.checked), Boolean(state.enabled))
    }
  )

  ipcMain.handle(
    'file:confirm-external-change',
    async (
      event,
      change: { filePath: string; exists: boolean; dirty: boolean; largeFileMode: boolean }
    ) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unable to resolve application window')

      if (!change.exists) {
        await dialog.showMessageBox(window, {
          type: 'warning',
          title: 'File Removed',
          message: 'The current file was deleted or moved by another program.',
          detail: 'Your text remains open. Use Save As to preserve it at a new location.',
          buttons: ['Keep Current']
        })
        return 'keep'
      }

      const compareUnavailable = change.largeFileMode
        ? ' Compare is unavailable while Large File Mode is active.'
        : ''
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'File Changed',
        message: 'The current file changed on disk.',
        detail:
          (change.dirty
            ? 'Reloading will discard your unsaved changes.'
            : 'Reload the version saved by the other program?') + compareUnavailable,
        buttons: change.largeFileMode
          ? ['Reload', 'Keep Current']
          : ['Reload', 'Compare Against Disk', 'Keep Current'],
        defaultId: change.largeFileMode ? 1 : 2,
        cancelId: change.largeFileMode ? 1 : 2,
        noLink: true
      })

      if (result.response === 0) return 'reload'
      return !change.largeFileMode && result.response === 1 ? 'compare' : 'keep'
    }
  )

  ipcMain.handle('file:external-change-handled', (event) => {
    if (externalChangePending) watchedFileSignature = pendingFileSignature
    externalChangePending = false
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window && watchedFilePath) {
      watchFileDirectories(window, watchedFilePath)
      checkWatchedFile(window)
    }
  })

  ipcMain.handle('recovery:save', async (event, recovery: RecoveryData) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    if (!isRecoveryData(recovery)) throw new Error('Invalid recovery data')

    try {
      const write = recoveryWrite.then(() =>
        writeFileAtomic(recoveryFilePath(), JSON.stringify(recovery), 'utf8')
      )
      recoveryWrite = write.catch(() => {})
      await write
      recoveryErrorShown = false
    } catch (error) {
      await reportRecoveryError(
        window,
        'Monaco Notepad could not save crash-recovery information.',
        error
      )
    }
  })

  ipcMain.handle('recovery:clear', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')

    try {
      await clearRecovery()
      recoveryErrorShown = false
    } catch (error) {
      await reportRecoveryError(
        window,
        'Monaco Notepad could not remove obsolete crash-recovery information.',
        error
      )
    }
  })

  ipcMain.handle('recovery:check', async (event): Promise<RecoveryData | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    // An explicit command-line or desktop file request wins over session state.
    if (pendingFilePath) return null

    let recovery: RecoveryData

    try {
      const value: unknown = JSON.parse(await readFile(recoveryFilePath(), 'utf8'))
      if (!isRecoveryData(value)) throw new Error('Recovery data has an invalid format.')
      recovery = value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null

      await reportRecoveryError(
        window,
        'The previous editing session could not be recovered.',
        error
      )
      try {
        await clearRecovery()
      } catch (clearError) {
        await reportRecoveryError(
          window,
          'The invalid crash-recovery information could not be removed.',
          clearError
        )
      }
      return null
    }

    // Untitled text is a deliberate single scratchpad, not a file-recovery prompt.
    // It is restored automatically after explicit file requests have been considered.
    if (recovery.filePath === null) return recovery

    const result = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Recover Document',
      message: 'Monaco Notepad found unsaved text from the previous session.',
      detail: recovery.filePath ?? 'Untitled document',
      buttons: ['Recover', 'Discard'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })

    if (result.response === 0) return recovery

    try {
      await clearRecovery()
    } catch (error) {
      await reportRecoveryError(
        window,
        'The discarded crash-recovery information could not be removed.',
        error
      )
    }
    return null
  })

  ipcMain.handle('document:confirm-unsaved', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window) {
      throw new Error('Unable to resolve application window')
    }

    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: 'Do you want to save changes to your document?',
      title: 'Monaco Notepad'
    })

    return ['save', 'discard', 'cancel'][result.response]
  })

  ipcMain.handle('app:close-approved', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window) {
      throw new Error('Unable to resolve application window')
    }

    approvedCloseWindows.add(window)
    window.close()
  })

  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
