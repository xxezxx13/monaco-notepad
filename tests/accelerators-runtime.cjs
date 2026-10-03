// Executes registered native shortcuts through their live MenuItem handlers
// and Monaco-owned shortcuts through real Electron sendInputEvent keyboard input.
// Uses an isolated profile, deterministic native dialogs, and a stubbed print path.
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
const { app, BrowserWindow, Menu } = require('electron')
const assert = require('node:assert/strict')
const nodeFs = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')
const { dialog } = require('electron')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let response = 1
let savePath
let openPath
let window
let server
let temporary
let printRequests = 0

dialog.showMessageBox = async () => ({
  response,
  checkboxChecked: false
})

dialog.showSaveDialog = async () => ({
  canceled: !savePath,
  filePath: savePath
})

dialog.showOpenDialog = async () => ({
  canceled: !openPath,
  filePaths: openPath ? [openPath] : []
})

// Keep Ctrl+P deterministic: expose one test printer and never open a
// real native print dialog.
app.on('web-contents-created', (_event, contents) => {
  contents.getPrintersAsync = async () => [
    {
      name: 'monaco-notepad-test-printer',
      displayName: 'Monaco Notepad Test Printer',
      description: 'Accelerator runtime stub',
      status: 0,
      isDefault: true,
      options: {}
    }
  ]

  contents.print = (_options, callback) => {
    printRequests++
    if (callback) callback(true, '')
  }
})

function loadCommandRegistry() {
  const sourcePath = path.resolve('src/shared/commands.ts')
  const source = nodeFs.readFileSync(sourcePath, 'utf8')
  const module = { exports: {} }

  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText

  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    Set,
    Error
  })

  return JSON.parse(
    JSON.stringify({
      shortcutDefinitions: module.exports.SHORTCUT_DEFINITIONS
    })
  )
}

const commandRegistry = loadCommandRegistry()
const executedShortcuts = new Set()
const nativeMenuExecutedShortcuts = new Set()
const keyboardExecutedShortcuts = new Set()

async function evaluate(code) {
  return window.webContents.executeJavaScript(code, true)
}

async function until(code, description, timeoutMs = 6000) {
  const attempts = Math.ceil(timeoutMs / 50)

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await evaluate(code)) return
    await delay(50)
  }

  throw new Error(`Timed out: ${description}`)
}

async function untilMain(predicate, description, timeoutMs = 6000) {
  const attempts = Math.ceil(timeoutMs / 50)

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return
    await delay(50)
  }

  throw new Error(`Timed out: ${description}`)
}

async function setText(text) {
  await evaluate(`editor.setValue(${JSON.stringify(text)})`)
  await delay(150)
}

async function press(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode,
    modifiers
  })
  window.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode,
    modifiers
  })
  await delay(100)
}

function shortcutDefinition(id) {
  const shortcut = commandRegistry.shortcutDefinitions.find((entry) => entry.id === id)
  assert.ok(shortcut, `Canonical shortcut: ${id}`)
  return shortcut
}

function acceleratorInput(accelerator) {
  const parts = accelerator.split('+')
  const key = parts.pop()
  const modifiers = []

  for (const modifier of parts) {
    switch (modifier) {
      case 'CmdOrCtrl':
      case 'Ctrl':
        modifiers.push('control')
        break
      case 'Shift':
        modifiers.push('shift')
        break
      case 'Alt':
        modifiers.push('alt')
        break
      default:
        throw new Error(`Unsupported accelerator modifier: ${modifier}`)
    }
  }

  // Electron accelerator notation expresses the shifted "=" key as "Plus".
  // sendInputEvent operates on the physical key event, so materialize the
  // Shift modifier needed to produce "+" on a standard keyboard.
  if (key === 'Plus') {
    if (!modifiers.includes('shift')) modifiers.push('shift')
    return { keyCode: '=', modifiers }
  }

  return { keyCode: key, modifiers }
}

async function pressShortcut(id) {
  const shortcut = shortcutDefinition(id)

  if (shortcut.registerAccelerator === false) {
    // Monaco-owned shortcuts are renderer keyboard behavior, so exercise them
    // through genuine Electron sendInputEvent input.
    const { keyCode, modifiers } = acceleratorInput(shortcut.accelerator)

    window.focus()
    await delay(50)
    await evaluate(`editor.focus()`)
    await until(`editor.hasTextFocus()`, `${shortcut.accelerator} Monaco editor focus`)

    await press(keyCode, modifiers)
    keyboardExecutedShortcuts.add(id)
  } else {
    // Registered application accelerators belong to Electron's live MenuItem
    // layer. Verify the native registration, then execute its production handler.
    const nativeLabel = shortcut.menuLabel ?? shortcut.label
    const item = menuItem(nativeLabel)

    assert.ok(item, `Native menu item: ${nativeLabel}`)
    assert.equal(
      item.accelerator,
      shortcut.accelerator,
      `${nativeLabel} live accelerator must match the canonical registry`
    )
    assert.notEqual(
      item.registerAccelerator,
      false,
      `${nativeLabel} must remain registered as a native accelerator`
    )
    assert.equal(item.enabled, true, `${nativeLabel} must be enabled before execution`)
    assert.notEqual(item.visible, false, `${nativeLabel} must be visible before execution`)
    assert.equal(
      typeof item.click,
      'function',
      `${nativeLabel} must expose its production click handler`
    )

    item.click(item, window, {})
    nativeMenuExecutedShortcuts.add(id)

    // Each caller independently verifies the resulting application behavior.
    await delay(100)
  }

  executedShortcuts.add(id)
}

function menuItem(label, menu = Menu.getApplicationMenu()) {
  for (const item of menu.items) {
    if (item.label === label) return item

    const nested = item.submenu && menuItem(label, item.submenu)
    if (nested) return nested
  }
}

async function run() {
  assert.equal(commandRegistry.shortcutDefinitions.length, 28)

  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'monaco-notepad-accelerators-'))

  app.setPath('userData', path.join(temporary, 'profile'))
  app.setPath('sessionData', path.join(temporary, 'session'))

  const { createServer } = await import('vite')

  server = await createServer({
    configFile: false,
    root: path.resolve('src/renderer'),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error'
  })

  await server.listen()
  process.env.ELECTRON_RENDERER_URL = server.resolvedUrls.local[0]

  require('../out/main/index.js')
  await app.whenReady()

  for (let attempt = 0; attempt < 120; attempt++) {
    window = BrowserWindow.getAllWindows()[0]
    if (window && !window.webContents.isLoading()) break
    await delay(50)
  }

  assert.ok(window, 'main window')

  await until(
    `!!window.api &&
      performance.getEntriesByType('resource').some(
        (entry) => /monaco-editor.*editor.*api/.test(entry.name)
      )`,
    'Monaco editor module'
  )

  await evaluate(`(async () => {
    const url = performance
      .getEntriesByType('resource')
      .find((entry) => /monaco-editor.*editor.*api/.test(entry.name)).name

    window.monaco = await import(url)
    window.editor = monaco.editor.getEditors()[0]
  })()`)

  await until(`!!window.editor`, 'editor startup')
  await delay(300)

  // -------------------------------------------------------------------
  // Native Electron accelerators: file commands.
  // -------------------------------------------------------------------

  await setText('discard me for New')
  response = 1
  await pressShortcut('new')
  await until(
    `editor.getValue() === '' &&
      document.title.includes('Untitled') &&
      !document.title.startsWith('*')`,
    'Ctrl+N New'
  )

  openPath = path.join(temporary, 'accelerator-open.txt')
  await fs.writeFile(openPath, 'opened by Ctrl+O', 'utf8')
  response = 0

  await pressShortcut('open')
  await until(
    `editor.getValue() === 'opened by Ctrl+O' &&
      document.title === 'accelerator-open.txt - Monaco Notepad'`,
    'Ctrl+O Open'
  )

  await setText('saved by Ctrl+S')
  await pressShortcut('save')

  await untilMain(
    async () => (await fs.readFile(openPath, 'utf8')) === 'saved by Ctrl+S',
    'Ctrl+S Save'
  )

  savePath = path.join(temporary, 'accelerator-save-as.txt')
  await pressShortcut('save-as')

  await until(
    `document.title === 'accelerator-save-as.txt - Monaco Notepad' &&
      !document.title.startsWith('*')`,
    'Ctrl+Shift+S Save As'
  )
  assert.equal(await fs.readFile(savePath, 'utf8'), 'saved by Ctrl+S')

  await setText('dirty before reload')
  response = 0
  await pressShortcut('reload')
  await until(`editor.getValue() === 'saved by Ctrl+S'`, 'Ctrl+Shift+R Reload from Disk')

  const printCountBefore = printRequests
  await pressShortcut('print')
  await untilMain(() => printRequests > printCountBefore, 'Ctrl+P Print')

  // -------------------------------------------------------------------
  // Undo / Redo.
  // -------------------------------------------------------------------

  await setText('undo base')
  await evaluate(`(() => {
    editor.pushUndoStop()
    const model = editor.getModel()
    const line = model.getLineCount()
    const column = model.getLineMaxColumn(line)

    editor.executeEdits('accelerator-runtime', [{
      range: new monaco.Range(line, column, line, column),
      text: '!'
    }])

    editor.pushUndoStop()
  })()`)

  await until(`editor.getValue() === 'undo base!' && editor.getModel().canUndo()`, 'undo fixture')

  await pressShortcut('undo')
  await until(`editor.getValue() === 'undo base'`, 'Ctrl+Z Undo')

  await pressShortcut('redo')
  await until(`editor.getValue() === 'undo base!'`, 'Ctrl+Y Redo')

  // -------------------------------------------------------------------
  // Monaco-owned comment / bracket accelerators.
  // -------------------------------------------------------------------

  await setText('const value = 1')
  await evaluate(`
    monaco.editor.setModelLanguage(editor.getModel(), 'javascript')
    editor.setPosition({ lineNumber: 1, column: 1 })
    editor.focus()
  `)

  await pressShortcut('toggle-line-comment')
  await until(
    `editor.getModel().getLineContent(1).trimStart().startsWith('//')`,
    'Ctrl+/ Toggle Line Comment'
  )

  await setText('(accelerator)')
  await evaluate(`
    monaco.editor.setModelLanguage(editor.getModel(), 'plaintext')
    editor.setPosition({ lineNumber: 1, column: 1 })
    editor.focus()
  `)

  const bracketColumnBefore = await evaluate(`editor.getPosition().column`)
  await pressShortcut('matching-bracket')
  await until(
    `editor.getPosition().column !== ${bracketColumnBefore}`,
    'Ctrl+Shift+Backslash Go to Matching Bracket'
  )

  // -------------------------------------------------------------------
  // Filter / Find / Find Next / Find Previous / Replace / Go To.
  // -------------------------------------------------------------------

  await pressShortcut('filter-lines')
  await until(`!document.getElementById('line-filter').hidden`, 'Ctrl+Shift+F Filter Lines')
  await evaluate(`document.getElementById('line-filter-close').click()`)
  await until(`document.getElementById('line-filter').hidden`, 'close Filter Lines')

  await setText('alpha beta alpha')
  await evaluate(`
    editor.setSelection(new monaco.Selection(1, 1, 1, 6))
    editor.focus()
  `)

  await pressShortcut('find')
  await until(
    `document.activeElement?.closest('.find-widget') !== null`,
    'Ctrl+F Find widget focus'
  )

  await pressShortcut('find-next')
  await until(`editor.getSelection().startColumn === 12`, 'F3 Find Next to second match')

  await pressShortcut('find-next')
  await until(`editor.getSelection().startColumn === 1`, 'F3 Find Next wraps to first match')

  await pressShortcut('find-previous')
  await until(
    `editor.getSelection().startColumn === 12`,
    'Shift+F3 Find Previous wraps to last match'
  )

  await pressShortcut('find-previous')
  await until(
    `editor.getSelection().startColumn === 1`,
    'Shift+F3 Find Previous returns to first match'
  )

  await press('Escape')
  await until(
    `document.querySelector('.find-widget')?.classList.contains('visible') === false`,
    'Find widget closes'
  )

  await evaluate(`editor.focus()`)

  await pressShortcut('find-next')
  await until(
    `editor.getSelection().startColumn === 12`,
    'F3 Find Next advances with widget closed'
  )

  await pressShortcut('find-previous')
  await until(
    `editor.getSelection().startColumn === 1`,
    'Shift+F3 Find Previous advances with widget closed'
  )

  await evaluate(`editor.focus()`)
  await pressShortcut('replace')
  await until(
    `(() => {
      const widget = document.querySelector('.find-widget')
      const replace = widget?.querySelector('.replace-part')

      return widget?.classList.contains('visible') &&
        replace &&
        getComputedStyle(replace).display !== 'none'
    })()`,
    'Ctrl+H Replace'
  )

  await press('Escape')
  await delay(100)

  await setText('line one\nline two\nline three\nline four')
  await evaluate(`editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus()`)

  await pressShortcut('go-to')
  await until(`document.activeElement?.closest('.quick-input-widget') !== null`, 'Ctrl+G Go To')

  assert.equal(await evaluate(`document.activeElement?.value ?? null`), ':', 'Ctrl+G Go To prefix')

  await window.webContents.insertText('3')

  await until(`document.activeElement?.value === ':3'`, 'Ctrl+G Go To line input')

  await press('Enter')

  await until(`editor.getPosition().lineNumber === 3`, 'Ctrl+G Go To line 3')

  await until(`editor.hasTextFocus()`, 'Ctrl+G Go To editor focus restore')

  // -------------------------------------------------------------------
  // Bookmark accelerators.
  // -------------------------------------------------------------------

  await setText('line one\nline two\nline three\nline four')

  await evaluate(`editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus()`)
  await pressShortcut('bookmark-toggle')

  await evaluate(`editor.setPosition({ lineNumber: 3, column: 1 }); editor.focus()`)
  await pressShortcut('bookmark-toggle')

  await evaluate(`editor.setPosition({ lineNumber: 2, column: 1 }); editor.focus()`)
  await pressShortcut('bookmark-next')
  await until(`editor.getPosition().lineNumber === 3`, 'F2 Next Bookmark')

  await pressShortcut('bookmark-previous')
  await until(`editor.getPosition().lineNumber === 1`, 'Shift+F2 Previous Bookmark')

  // -------------------------------------------------------------------
  // Selection / timestamp / Read Only.
  // -------------------------------------------------------------------

  await setText('select all accelerator')
  await evaluate(`editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus()`)

  await pressShortcut('select-all')
  assert.equal(
    await evaluate(`editor.getModel().getValueInRange(editor.getSelection())`),
    'select all accelerator'
  )

  await setText('timestamp accelerator')
  await evaluate(`
    editor.setSelection(editor.getModel().getFullModelRange())
    editor.focus()
  `)

  await pressShortcut('time-date')
  await until(
    `editor.getValue() !== 'timestamp accelerator' && editor.getValue().length > 0`,
    'F5 Time/Date'
  )

  await pressShortcut('toggle-read-only')
  await until(`editor.getOption(monaco.editor.EditorOption.readOnly)`, 'Ctrl+Alt+R Read Only')
  assert.equal(menuItem('Read Only').checked, true)

  // Restore editability for the remaining tests.
  await pressShortcut('toggle-read-only')
  await until(
    `!editor.getOption(monaco.editor.EditorOption.readOnly)`,
    'Ctrl+Alt+R Read Only restore'
  )

  // -------------------------------------------------------------------
  // Preferences.
  // -------------------------------------------------------------------

  await evaluate(`editor.focus()`)
  await pressShortcut('preferences')

  await untilMain(
    () =>
      BrowserWindow.getAllWindows().some(
        (candidate) =>
          candidate !== window && candidate.webContents.getURL().includes('preferences')
      ),
    'Ctrl+, Preferences window'
  )

  const preferencesWindow = BrowserWindow.getAllWindows().find(
    (candidate) => candidate !== window && candidate.webContents.getURL().includes('preferences')
  )

  assert.ok(preferencesWindow, 'Preferences accelerator window')
  preferencesWindow.close()

  await untilMain(
    () =>
      !BrowserWindow.getAllWindows().some(
        (candidate) =>
          candidate !== window && candidate.webContents.getURL().includes('preferences')
      ),
    'Preferences accelerator window close'
  )

  // -------------------------------------------------------------------
  // Direct native shortcuts.
  // -------------------------------------------------------------------

  assert.equal(
    await evaluate(`document.getElementById('editor').classList.contains('hide-line-numbers')`),
    true
  )

  await pressShortcut('show-line-numbers')
  await until(`editor.getLayoutInfo().contentLeft > 20`, 'Ctrl+Shift+F9 Show Line Numbers')

  // Restore default hidden-gutter state.
  await pressShortcut('show-line-numbers')
  await until(`editor.getLayoutInfo().contentLeft === 10`, 'Ctrl+Shift+F9 hide Line Numbers')

  assert.equal(window.isFullScreen(), false)
  await pressShortcut('full-screen')
  await untilMain(() => window.isFullScreen(), 'F11 Full Screen')

  // Restore normal window state.
  await pressShortcut('full-screen')
  await untilMain(() => !window.isFullScreen(), 'F11 exit Full Screen')

  // -------------------------------------------------------------------
  // Main-process-owned zoom shortcuts routed to Monaco.
  // -------------------------------------------------------------------

  await evaluate(`editor.focus()`)
  const initialZoom = await evaluate(`monaco.editor.EditorZoom.getZoomLevel()`)
  assert.equal(window.webContents.getZoomFactor(), 1)

  await pressShortcut('zoom-in')
  await until(`monaco.editor.EditorZoom.getZoomLevel() > ${initialZoom}`, 'Ctrl+Plus Zoom In')
  assert.equal(window.webContents.getZoomFactor(), 1)

  await pressShortcut('zoom-in')
  const elevatedZoom = await evaluate(`monaco.editor.EditorZoom.getZoomLevel()`)
  assert.ok(elevatedZoom > initialZoom)

  await pressShortcut('zoom-out')
  await until(`monaco.editor.EditorZoom.getZoomLevel() < ${elevatedZoom}`, 'Ctrl+- Zoom Out')
  assert.equal(window.webContents.getZoomFactor(), 1)

  await pressShortcut('zoom-reset')
  await until(`monaco.editor.EditorZoom.getZoomLevel() === 0`, 'Ctrl+0 Reset Zoom')
  assert.equal(window.webContents.getZoomFactor(), 1)

  // -------------------------------------------------------------------
  // Registry completeness: execution, not merely string presence.
  // -------------------------------------------------------------------

  const expectedShortcutIds = commandRegistry.shortcutDefinitions.map(({ id }) => id).sort()
  const expectedNativeShortcutIds = commandRegistry.shortcutDefinitions
    .filter(({ registerAccelerator }) => registerAccelerator !== false)
    .map(({ id }) => id)
    .sort()
  const expectedKeyboardShortcutIds = commandRegistry.shortcutDefinitions
    .filter(({ registerAccelerator }) => registerAccelerator === false)
    .map(({ id }) => id)
    .sort()

  const executedShortcutIds = [...executedShortcuts].sort()
  const executedNativeShortcutIds = [...nativeMenuExecutedShortcuts].sort()
  const executedKeyboardShortcutIds = [...keyboardExecutedShortcuts].sort()

  assert.deepEqual(
    executedNativeShortcutIds,
    expectedNativeShortcutIds,
    'Every registered native shortcut must execute through its live MenuItem handler'
  )

  assert.deepEqual(
    executedKeyboardShortcutIds,
    expectedKeyboardShortcutIds,
    'Every Monaco-owned shortcut must execute through sendInputEvent'
  )

  assert.deepEqual(
    executedShortcutIds,
    expectedShortcutIds,
    'Every canonical shortcut must execute through exactly one supported shortcut path'
  )

  console.log(
    `PASS deterministic shortcut execution: ` +
      `${executedNativeShortcutIds.length} native MenuItem routes + ` +
      `${executedKeyboardShortcutIds.length} actual keyboard routes ` +
      `(${executedShortcutIds.length} canonical shortcuts total)`
  )
}

run()
  .then(async () => {
    if (server) await server.close()
    app.exit(0)
  })
  .catch(async (error) => {
    console.error(error)
    if (server) await server.close()
    app.exit(1)
  })
