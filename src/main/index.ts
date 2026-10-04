import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  clipboard,
  type IpcMainInvokeEvent
} from 'electron'
import { isAbsolute, join, resolve } from 'path'
import { basename, dirname } from 'node:path'
import { appendFileSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
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
  type OpenFileReadOptions,
  type SaveFileRequest
} from './files'
import {
  classifyFileChange,
  createSaveBaselineTracker,
  fileSignature,
  type ConflictChoice,
  type ExternalFileChangeKind
} from './conflict'
import { FollowReader } from './follow'
import { portalThemeFromOutput, type PortalTheme } from './portal'
import { selectionDigests, type SelectionHashAlgorithm } from './selection-hash'
import {
  activateMenuContextState,
  installMenu,
  recordRecentFile,
  setMenuContextState
} from './menu'
import type { MenuContextState } from '../shared/commands'
import {
  preferences,
  getFilePosition,
  saveFilePosition,
  type Preferences,
  type FilePosition
} from './preferences'
import { createPortableSettingsFile, parsePortableSettingsJson } from './settings-portability'

const approvedCloseWindows = new WeakSet<BrowserWindow>()
const documentWindows = new Set<BrowserWindow>()
let mainWindow: BrowserWindow | null = null
let preferencesWindow: BrowserWindow | null = null
let startupPendingFilePath: string | null = null
const saveBaselines = new WeakMap<BrowserWindow, ReturnType<typeof createSaveBaselineTracker>>()

function saveBaselineFor(window: BrowserWindow): ReturnType<typeof createSaveBaselineTracker> {
  let baseline = saveBaselines.get(window)
  if (!baseline) {
    baseline = createSaveBaselineTracker()
    saveBaselines.set(window, baseline)
  }
  return baseline
}
interface DocumentWindowRuntime {
  watchedFilePath: string | null
  watchedFileSignature: string | null
  fileWatchers: FSWatcher[]
  fileWatchTimer: NodeJS.Timeout | null
  externalChangePending: boolean
  pendingFileSignature: string | null
  savesInProgress: number
  followReader: FollowReader | null
  followPoll: Promise<void>
  sessionOwner: boolean
  rendererReady: boolean
  pendingFilePath: string | null
}

const documentWindowRuntimes = new WeakMap<BrowserWindow, DocumentWindowRuntime>()

function documentWindowRuntimeFor(window: BrowserWindow): DocumentWindowRuntime {
  let runtime = documentWindowRuntimes.get(window)
  if (!runtime) {
    runtime = {
      watchedFilePath: null,
      watchedFileSignature: null,
      fileWatchers: [],
      fileWatchTimer: null,
      externalChangePending: false,
      pendingFileSignature: null,
      savesInProgress: 0,
      followReader: null,
      followPoll: Promise.resolve(),
      sessionOwner: false,
      rendererReady: false,
      pendingFilePath: null
    }
    documentWindowRuntimes.set(window, runtime)
  }
  return runtime
}

function firstLiveDocumentWindow(): BrowserWindow | null {
  for (const window of documentWindows) {
    if (!window.isDestroyed()) return window
  }
  return null
}

function broadcastToDocumentWindows(channel: string, ...args: unknown[]): void {
  for (const window of documentWindows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(channel, ...args)
  }
}

let recoveryErrorShown = false
let recoveryWrite: Promise<void> = Promise.resolve()
let portalMonitor: ReturnType<typeof spawn> | null = null
const activeOpenRequests = new Map<number, Map<string, AbortController>>()
const startupTracePath = process.env.MONACO_NOTEPAD_STARTUP_TRACE?.trim() || null
const startupTraceStartedAt = process.hrtime.bigint()
const startupTraceRunId = `${process.pid}-${Date.now().toString(36)}`

function traceStartup(event: string, detail: Record<string, unknown> = {}): void {
  if (!startupTracePath) return

  try {
    appendFileSync(
      startupTracePath,
      `${JSON.stringify({
        runId: startupTraceRunId,
        pid: process.pid,
        elapsedMs: Number(process.hrtime.bigint() - startupTraceStartedAt) / 1_000_000,
        event,
        ...detail
      })}\n`,
      'utf8'
    )
  } catch {
    // Startup diagnostics must never interfere with application startup.
  }
}

traceStartup('process-entry', {
  packaged: app.isPackaged,
  platform: process.platform,
  flatpak: Boolean(process.env.FLATPAK_ID),
  sessionType: process.env.XDG_SESSION_TYPE ?? null,
  wayland: Boolean(process.env.WAYLAND_DISPLAY),
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron ?? null,
  chromiumVersion: process.versions.chrome ?? null,
  nodeVersion: process.versions.node
})

function beginOpenRequest(
  event: IpcMainInvokeEvent,
  requestId: unknown
): { options: OpenFileReadOptions; finish: () => void } {
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 100) {
    return { options: {}, finish: () => undefined }
  }

  const sender = event.sender
  const senderId = sender.id
  let senderRequests = activeOpenRequests.get(senderId)
  if (!senderRequests) {
    senderRequests = new Map()
    activeOpenRequests.set(senderId, senderRequests)
  }

  senderRequests.get(requestId)?.abort()
  const controller = new AbortController()
  const abortOnDestroyed = (): void => controller.abort()
  sender.once('destroyed', abortOnDestroyed)
  senderRequests.set(requestId, controller)

  return {
    options: {
      signal: controller.signal,
      onProgress: (progress) => {
        if (!sender.isDestroyed()) {
          sender.send('file:open-progress', { requestId, ...progress })
        }
      }
    },
    finish: () => {
      if (!sender.isDestroyed()) sender.removeListener('destroyed', abortOnDestroyed)
      const currentRequests = activeOpenRequests.get(senderId)
      if (currentRequests?.get(requestId) !== controller) return
      currentRequests.delete(requestId)
      if (currentRequests.size === 0) activeOpenRequests.delete(senderId)
    }
  }
}

function sendPortalTheme(theme: PortalTheme): void {
  if (preferences.get('theme') !== 'system') return

  broadcastToDocumentWindows('theme:portal-changed', theme)
  preferencesWindow?.webContents.send('theme:portal-changed', theme)
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

function stopWatchingFile(window: BrowserWindow): void {
  const runtime = documentWindowRuntimeFor(window)
  if (runtime.fileWatchTimer) clearTimeout(runtime.fileWatchTimer)
  runtime.fileWatchTimer = null
  for (const watcher of runtime.fileWatchers) watcher.close()
  runtime.fileWatchers = []
  runtime.watchedFilePath = null
  runtime.watchedFileSignature = null
  runtime.externalChangePending = false
  runtime.pendingFileSignature = null
}

function checkWatchedFile(window: BrowserWindow): void {
  const runtime = documentWindowRuntimeFor(window)
  const watchedFilePath = runtime.watchedFilePath
  if (!watchedFilePath || runtime.externalChangePending || runtime.savesInProgress > 0) return

  if (runtime.followReader?.filePath === watchedFilePath) {
    runtime.followPoll = runtime.followPoll
      .then(async () => {
        const currentPath = runtime.watchedFilePath
        if (!runtime.followReader || !currentPath || runtime.followReader.filePath !== currentPath)
          return
        const updates = await runtime.followReader.poll()
        for (const update of updates) window.webContents.send('file:follow-update', update)
        runtime.watchedFileSignature = fileSignature(currentPath)
      })
      .catch((error) => {
        window.webContents.send(
          'file:follow-error',
          error instanceof Error ? error.message : String(error)
        )
      })
    return
  }

  const previousSignature = runtime.watchedFileSignature
  const signature = fileSignature(watchedFilePath)
  if (signature === previousSignature) return

  runtime.externalChangePending = true
  runtime.pendingFileSignature = signature
  window.webContents.send('file:external-change', {
    filePath: watchedFilePath,
    exists: signature !== null,
    kind: classifyFileChange(previousSignature, signature),
    signature
  })
}

function watchFile(window: BrowserWindow, filePath: string | null): void {
  stopWatchingFile(window)
  if (!filePath) return

  const runtime = documentWindowRuntimeFor(window)
  runtime.watchedFilePath = filePath
  runtime.watchedFileSignature = fileSignature(filePath)

  watchFileDirectories(window, filePath)
}

function watchFileDirectories(window: BrowserWindow, filePath: string): void {
  const runtime = documentWindowRuntimeFor(window)
  for (const watcher of runtime.fileWatchers) watcher.close()
  runtime.fileWatchers = []

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

        if (runtime.fileWatchTimer) clearTimeout(runtime.fileWatchTimer)
        runtime.fileWatchTimer = setTimeout(() => checkWatchedFile(window), 150)
      })

      runtime.fileWatchers.push(watcher)
      watcher.on('error', (error) => {
        stopWatchingFile(window)
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
    stopWatchingFile(window)
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
  if (!mainWindow || mainWindow.isDestroyed()) {
    startupPendingFilePath = filePath
    return
  }

  const windowRuntime = documentWindowRuntimeFor(mainWindow)
  windowRuntime.pendingFilePath = filePath

  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()

  if (!mainWindow.webContents.isLoading() && windowRuntime.rendererReady) {
    windowRuntime.pendingFilePath = null
    mainWindow.webContents.send('app:open-file-requested', filePath)
  }
}

traceStartup('single-instance-lock-attempt')
const hasSingleInstanceLock = app.requestSingleInstanceLock()
traceStartup('single-instance-lock-result', { acquired: hasSingleInstanceLock })

// Let Chromium choose Wayland when it is available, while retaining X11/XWayland fallback.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

if (!hasSingleInstanceLock) {
  traceStartup('single-instance-lock-denied')
  app.quit()
} else {
  startupPendingFilePath = filePathFromArguments(process.argv)

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const filePath = filePathFromArguments(argv, workingDirectory)
    traceStartup('second-instance', {
      hasFilePath: Boolean(filePath),
      windowExists: Boolean(mainWindow),
      rendererReady: mainWindow ? documentWindowRuntimeFor(mainWindow).rendererReady : false
    })
    if (filePath) requestFileOpen(filePath)
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function openExternalWebUrl(rawUrl: string): void {
  try {
    const url = new URL(rawUrl)

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return

    void shell.openExternal(url.toString())
  } catch {
    // Ignore malformed or unsupported external URLs.
  }
}

function installRendererNavigationPolicy(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalWebUrl(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternalWebUrl(url)
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101722' : '#ffffff',
    darkTheme: nativeTheme.shouldUseDarkColors,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  installRendererNavigationPolicy(preferencesWindow)

  preferencesWindow.on('ready-to-show', () => {
    preferencesWindow?.show()
  })

  preferencesWindow.on('closed', () => {
    preferencesWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    preferencesWindow.loadURL(
      new URL('preferences/preferences.html', process.env['ELECTRON_RENDERER_URL']).toString()
    )
  } else {
    preferencesWindow.loadFile(join(__dirname, '../renderer/preferences/preferences.html'))
  }
}

function createWindow(sessionOwner = false): void {
  traceStartup('window-construction-begin')

  // Create the browser window.
  const window = new BrowserWindow({
    width: preferences.get('windowWidth'),
    height: preferences.get('windowHeight'),
    minWidth: 400,
    minHeight: 250,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101722' : '#ffffff',
    darkTheme: nativeTheme.shouldUseDarkColors,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  documentWindows.add(window)
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = window
  traceStartup('window-construction-end', { webContentsId: window.webContents.id })

  const windowRuntime = documentWindowRuntimeFor(window)
  windowRuntime.sessionOwner = sessionOwner
  if (startupPendingFilePath) {
    windowRuntime.pendingFilePath = startupPendingFilePath
    startupPendingFilePath = null
  }

  window.on('ready-to-show', () => {
    traceStartup('ready-to-show')
    traceStartup('show-requested', { reason: 'ready-to-show' })
    window.show()
  })

  window.on('show', () => {
    traceStartup('window-show', { visible: window.isVisible() })
  })

  window.on('unresponsive', () => {
    traceStartup('window-unresponsive')
  })

  window.webContents.on('did-start-loading', () => {
    traceStartup('load-started')
  })

  window.webContents.on('did-finish-load', () => {
    traceStartup('load-finished')
  })

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      traceStartup('load-failed', { errorCode, errorDescription, isMainFrame })
    }
  )

  window.webContents.on('render-process-gone', (_event, details) => {
    traceStartup('render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode
    })
  })

  window.on('focus', () => {
    checkWatchedFile(window)
    activateMenuContextState(window)
  })

  window.on('resize', () => {
    const [width, height] = window.getSize()
    preferences.set('windowWidth', width)
    preferences.set('windowHeight', height)
  })

  window.on('close', (event) => {
    if (approvedCloseWindows.has(window)) {
      approvedCloseWindows.delete(window)
      return
    }

    event.preventDefault()
    window.webContents.send('app:close-requested')
  })

  window.on('closed', () => {
    traceStartup('window-closed')
    stopWatchingFile(window)
    windowRuntime.rendererReady = false
    documentWindows.delete(window)
    if (mainWindow === window) mainWindow = firstLiveDocumentWindow()
  })

  // Chromium consumes standard Ctrl++ / Ctrl+- editor zoom chords before
  // the renderer can reliably observe them. Own editor zoom at the
  // WebContents boundary and route it through the same command path as
  // the View menu while preventing Chromium page zoom.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return

    let command: 'zoom-in' | 'zoom-out' | 'zoom-reset' | null = null

    if (input.key === '+') command = 'zoom-in'
    else if (input.key === '-') command = 'zoom-out'
    else if (input.key === '0') command = 'zoom-reset'

    if (!command) return

    event.preventDefault()
    window.webContents.send('menu:command', command)
  })

  installRendererNavigationPolicy(window)

  installMenu(window)

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    traceStartup('load-begin', { source: 'development' })
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    traceStartup('load-begin', { source: 'packaged' })
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.once('before-quit', () => traceStartup('before-quit'))
app.once('will-quit', () => traceStartup('will-quit'))
app.once('will-quit', stopPortalThemeMonitor)
process.once('exit', () => traceStartup('process-exit'))
process.once('exit', stopPortalThemeMonitor)
app.once('ready', () => traceStartup('app-ready'))

app.whenReady().then(() => {
  traceStartup('when-ready-resolved')
  if (!hasSingleInstanceLock) return

  nativeTheme.themeSource = preferences.get('theme')

  nativeTheme.on('updated', () => {
    if (preferences.get('theme') !== 'system') return

    broadcastToDocumentWindows('theme:system-changed')
    preferencesWindow?.webContents.send('theme:system-changed')
  })
  queryPortalTheme()
  startPortalThemeMonitor()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const getAllPreferences = (): Preferences => ({
    wordWrap: preferences.get('wordWrap'),
    typewriterScrolling: preferences.get('typewriterScrolling'),
    zoomLevel: preferences.get('zoomLevel'),
    statusBarVisible: preferences.get('statusBarVisible'),
    showWhitespace: preferences.get('showWhitespace'),
    showLineNumbers: preferences.get('showLineNumbers'),
    reopenLastDocument: preferences.get('reopenLastDocument'),
    backupOnSave: preferences.get('backupOnSave'),
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
  })

  ipcMain.handle('preferences:get-all', getAllPreferences)

  ipcMain.handle('preferences:set', (_event, key: keyof Preferences, value: unknown) => {
    preferences.set(key, value)

    if (key === 'theme' && (value === 'system' || value === 'light' || value === 'dark')) {
      nativeTheme.themeSource = value
    }

    broadcastToDocumentWindows('preferences:changed', { [key]: value })
    if (preferencesWindow) {
      preferencesWindow.webContents.send('preferences:changed', { [key]: value })
    }
    const menuKeys: (keyof Preferences)[] = [
      'wordWrap',
      'typewriterScrolling',
      'showWhitespace',
      'showLineNumbers',
      'statusBarVisible',
      'reopenLastDocument',
      'tabSize',
      'insertSpaces',
      'autoIndent',
      'trimTrailingWhitespaceOnSave',
      'largeFileWarningMiB',
      'theme'
    ]
    if (menuKeys.includes(key) && mainWindow) installMenu(mainWindow)
  })

  ipcMain.handle('preferences:export', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== preferencesWindow) {
      throw new Error('Settings export is only available from Preferences')
    }

    const result = await dialog.showSaveDialog(window, {
      title: 'Export Settings',
      defaultPath: 'monaco-notepad-settings.json',
      filters: [{ name: 'Monaco Notepad Settings', extensions: ['json'] }]
    })

    if (result.canceled || !result.filePath) return 'canceled'

    const document = createPortableSettingsFile(getAllPreferences())
    await writeFileAtomic(result.filePath, `${JSON.stringify(document, null, 2)}\n`)
    return 'exported'
  })

  ipcMain.handle('preferences:import', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== preferencesWindow) {
      throw new Error('Settings import is only available from Preferences')
    }

    const result = await dialog.showOpenDialog(window, {
      title: 'Import Settings',
      properties: ['openFile'],
      filters: [{ name: 'Monaco Notepad Settings', extensions: ['json'] }]
    })

    if (result.canceled || result.filePaths.length === 0) return 'canceled'

    let document: ReturnType<typeof parsePortableSettingsJson>

    try {
      document = parsePortableSettingsJson(await readFile(result.filePaths[0], 'utf8'))
    } catch (error) {
      await dialog.showMessageBox(window, {
        type: 'error',
        title: 'Import Settings',
        message: 'Settings were not imported.',
        detail: error instanceof Error ? error.message : String(error)
      })
      return 'invalid'
    }

    const mergedPreferences: Preferences = { ...getAllPreferences(), ...document.preferences }
    preferences.set(mergedPreferences)
    nativeTheme.themeSource = document.preferences.theme

    if (mainWindow) installMenu(mainWindow)
    broadcastToDocumentWindows('preferences:imported')
    preferencesWindow?.webContents.send('preferences:imported')

    return 'imported'
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

  ipcMain.handle('app:is-session-owner', (event): boolean => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window === preferencesWindow) {
      throw new Error('Unable to resolve document window')
    }
    return documentWindowRuntimeFor(window).sessionOwner
  })

  ipcMain.handle('app:renderer-ready', (event, recoveryRestored = false) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    const windowRuntime = documentWindowRuntimeFor(window)

    traceStartup('renderer-ready-ipc', {
      recoveryRestored,
      pendingFile: Boolean(windowRuntime.pendingFilePath),
      windowVisible: window.isVisible()
    })
    windowRuntime.rendererReady = true

    if (!window.isVisible()) {
      traceStartup('show-requested', { reason: 'renderer-ready-fallback' })
      window.show()
    }
    if (windowRuntime.pendingFilePath) {
      const filePath = windowRuntime.pendingFilePath
      windowRuntime.pendingFilePath = null
      window.webContents.send('app:open-file-requested', filePath)
    } else if (
      windowRuntime.sessionOwner &&
      !recoveryRestored &&
      preferences.get('reopenLastDocument')
    ) {
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

  ipcMain.handle(
    'file:open',
    async (event, bomlessEncoding: BomlessFileEncoding = 'auto', requestId?: string) => {
      const window = BrowserWindow.fromWebContents(event.sender)

      if (!window) {
        throw new Error('Unable to resolve application window')
      }

      const openRequest = beginOpenRequest(event, requestId)

      try {
        const result = await openFileDialog(window, bomlessEncoding, openRequest.options)
        if (result) {
          saveBaselineFor(window).record(result.filePath)
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
      } finally {
        openRequest.finish()
      }
    }
  )

  ipcMain.handle(
    'file:open-path',
    async (
      event,
      filePath: string,
      bomlessEncoding: BomlessFileEncoding = 'auto',
      requestId?: string
    ) => {
      const window = BrowserWindow.fromWebContents(event.sender)

      if (!window) throw new Error('Unable to resolve application window')
      const openRequest = beginOpenRequest(event, requestId)

      try {
        const result = await openFilePath(filePath, bomlessEncoding, window, openRequest.options)
        if (result) {
          saveBaselineFor(window).record(result.filePath)
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
      } finally {
        openRequest.finish()
      }
    }
  )

  ipcMain.handle(
    'file:reopen-with-encoding',
    async (event, filePath: string, encoding: FileEncoding, requestId?: string) => {
      const window = BrowserWindow.fromWebContents(event.sender)

      if (!window) throw new Error('Unable to resolve application window')
      const openRequest = beginOpenRequest(event, requestId)

      try {
        if (!['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'windows1252'].includes(encoding)) {
          throw new Error('Unsupported file encoding')
        }

        const signatureBefore = fileSignature(filePath)
        if (signatureBefore === null) {
          throw new Error('The file could not be identified before reopening.')
        }

        const result = await reopenFilePath(filePath, encoding, window, openRequest.options)
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
      } finally {
        openRequest.finish()
      }
    }
  )

  ipcMain.handle('file:cancel-open', (event, requestId: string) => {
    if (typeof requestId !== 'string') return false
    const controller = activeOpenRequests.get(event.sender.id)?.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  })

  ipcMain.handle(
    'file:accept-reopen-baseline',
    (event, filePath: string, baselineSignature: string) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unable to resolve application window')
      if (
        typeof filePath !== 'string' ||
        filePath.length === 0 ||
        typeof baselineSignature !== 'string' ||
        baselineSignature.length === 0
      ) {
        throw new Error('Invalid reopen baseline')
      }

      saveBaselineFor(window).recordSignature(filePath, baselineSignature)
    }
  )

  ipcMain.handle(
    'file:read-for-compare',
    async (event, filePath: string, bomlessEncoding: BomlessFileEncoding, requestId?: string) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unable to resolve application window')
      const openRequest = beginOpenRequest(event, requestId)
      try {
        return await openFilePath(filePath, bomlessEncoding, window, openRequest.options)
      } catch {
        return null
      } finally {
        openRequest.finish()
      }
    }
  )

  ipcMain.handle(
    'file:save',
    async (
      event,
      request: SaveFileRequest & { baselineCheck?: boolean; expectedSignature?: string | null }
    ): Promise<
      | { action: 'saved'; filePath: string }
      | { action: 'conflict'; signature: string | null }
      | { action: 'cancelled' }
      | { action: 'error'; message: string }
    > => {
      const window = BrowserWindow.fromWebContents(event.sender)

      if (!window) {
        throw new Error('Unable to resolve application window')
      }

      if (
        request.filePath &&
        request.baselineCheck !== false &&
        saveBaselineFor(window).check(request.filePath)
      ) {
        return { action: 'conflict', signature: fileSignature(request.filePath) }
      }

      if (
        request.filePath &&
        request.baselineCheck === false &&
        request.expectedSignature !== undefined
      ) {
        const currentSignature = fileSignature(request.filePath)
        if (currentSignature !== request.expectedSignature) {
          return { action: 'conflict', signature: currentSignature }
        }
      }

      const windowRuntime = documentWindowRuntimeFor(window)
      windowRuntime.savesInProgress++
      try {
        const filePath = await saveFile(window, request, 'Save As', preferences.get('backupOnSave'))
        if (filePath) {
          saveBaselineFor(window).record(filePath)
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
        windowRuntime.savesInProgress--
        checkWatchedFile(window)
      }
    }
  )

  ipcMain.handle(
    'file:resolve-conflict',
    async (event, { filePath }: { filePath: string }): Promise<ConflictChoice> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unable to resolve application window')

      if (fileSignature(filePath) === null) {
        const result = await dialog.showMessageBox(window, {
          type: 'warning',
          title: 'File Removed',
          message: `${basename(filePath)} no longer exists on disk.`,
          detail: 'Save As preserves your editor contents without recreating the removed path.',
          buttons: ['Save As', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
        return result.response === 0 ? 'save-as' : 'cancel'
      }

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
      event,
      { title, text, fontFamily }: { title: string; text: string; fontFamily: string }
    ) => {
      const window = BrowserWindow.fromWebContents(event.sender)

      if (!window) throw new Error('Unable to resolve application window')

      try {
        const printers = await event.sender.getPrintersAsync()

        if (printers.length === 0) {
          await dialog.showMessageBox(window, {
            type: 'error',
            title: 'Print Error',
            message: 'No printers are configured.',
            detail:
              'Monaco Notepad could not find any CUPS printer destinations. Add a printer in your Linux system settings or CUPS, then try again.',
            buttons: ['OK']
          })
          return
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)

        await dialog.showMessageBox(window, {
          type: 'error',
          title: 'Print Error',
          message: 'Available printers could not be determined.',
          detail,
          buttons: ['OK']
        })
        return
      }

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

        const printResult = await new Promise<{
          success: boolean
          failureReason: string
        }>((resolvePrint) => {
          printWindow.webContents.print(
            { silent: false },
            (success, failureReason) => {
              resolvePrint({ success, failureReason })
            }
          )
        })

        if (
          !printResult.success &&
          printResult.failureReason !== 'Print job canceled'
        ) {
          await dialog.showMessageBox(window, {
            type: 'error',
            title: 'Print Error',
            message: 'The document could not be printed.',
            detail: printResult.failureReason || 'Unknown print error',
            buttons: ['OK']
          })
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)

        await dialog.showMessageBox(window, {
          type: 'error',
          title: 'Print Error',
          message: 'The document could not be printed.',
          detail,
          buttons: ['OK']
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
      const windowRuntime = documentWindowRuntimeFor(window)
      windowRuntime.followReader = await FollowReader.create(resolve(filePath), encoding)
      windowRuntime.externalChangePending = false
      windowRuntime.pendingFileSignature = null
      windowRuntime.watchedFileSignature = fileSignature(windowRuntime.followReader.filePath)
      return { size: windowRuntime.followReader.consumedBytes }
    }
  )

  ipcMain.handle('file:follow-stop', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    const windowRuntime = documentWindowRuntimeFor(window)
    await windowRuntime.followPoll
    windowRuntime.followReader = null
    windowRuntime.externalChangePending = false
    windowRuntime.pendingFileSignature = null
    if (windowRuntime.watchedFilePath) {
      windowRuntime.watchedFileSignature = fileSignature(windowRuntime.watchedFilePath)
    }
  })

  ipcMain.handle('menu:context-state', (event, state: MenuContextState) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window === preferencesWindow) {
      throw new Error('Unable to resolve document window')
    }

    setMenuContextState(window, {
      followActive: Boolean(state.followActive),
      followEnabled: Boolean(state.followEnabled),
      readOnly: Boolean(state.readOnly),
      readOnlyToggleEnabled: Boolean(state.readOnlyToggleEnabled)
    })
  })

  ipcMain.handle(
    'file:confirm-external-change',
    async (
      event,
      change: {
        filePath: string
        exists: boolean
        kind: ExternalFileChangeKind
        signature: string | null
        dirty: boolean
        largeFileMode: boolean
      }
    ): Promise<'reload' | 'keep' | 'compare' | 'save-as' | 'overwrite'> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unable to resolve application window')

      if (change.kind === 'deleted' || !change.exists) {
        const result = await dialog.showMessageBox(window, {
          type: 'warning',
          title: 'File Removed',
          message: 'The current file was deleted or moved by another program.',
          detail:
            'Your text remains open. Save As preserves it without recreating the removed path.',
          buttons: ['Save As', 'Keep Editing'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
        return result.response === 0 ? 'save-as' : 'keep'
      }

      const replaced = change.kind === 'replaced'
      const title = replaced ? 'File Replaced' : 'File Changed'
      const message = replaced
        ? 'The file at the current path was replaced by another file.'
        : 'The current file changed on disk.'
      const compareUnavailable = change.largeFileMode
        ? ' Compare is unavailable while Large File Mode is active.'
        : ''

      if (change.dirty) {
        const buttons = change.largeFileMode
          ? ['Keep Editing', 'Save As', 'Overwrite']
          : ['Keep Editing', 'Compare Against Disk', 'Save As', 'Overwrite']
        const result = await dialog.showMessageBox(window, {
          type: 'warning',
          title,
          message,
          detail:
            'Your editor has unsaved changes. Overwrite replaces the current disk version with your editor contents.' +
            compareUnavailable,
          buttons,
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })

        if (result.response === 0) return 'keep'
        if (!change.largeFileMode && result.response === 1) return 'compare'
        const saveAsIndex = change.largeFileMode ? 1 : 2
        return result.response === saveAsIndex ? 'save-as' : 'overwrite'
      }

      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title,
        message,
        detail:
          (replaced
            ? 'Reload the replacement now?'
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
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    const windowRuntime = documentWindowRuntimeFor(window)
    if (windowRuntime.externalChangePending) {
      windowRuntime.watchedFileSignature = windowRuntime.pendingFileSignature
    }
    windowRuntime.externalChangePending = false
    if (windowRuntime.watchedFilePath) {
      watchFileDirectories(window, windowRuntime.watchedFilePath)
      checkWatchedFile(window)
    }
  })

  ipcMain.handle('recovery:save', async (event, recovery: RecoveryData) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Unable to resolve application window')
    if (!documentWindowRuntimeFor(window).sessionOwner) return
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
    if (!documentWindowRuntimeFor(window).sessionOwner) return

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
    if (!documentWindowRuntimeFor(window).sessionOwner) return null
    // An explicit command-line or desktop file request wins over session state.
    if (documentWindowRuntimeFor(window).pendingFilePath) return null

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

  createWindow(true)
})

app.on('window-all-closed', () => {
  app.quit()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
