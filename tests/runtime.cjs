// Runs the actual sandboxed app with an isolated profile and temporary files.
// Native dialogs are answered deterministically; no personal documents are touched.
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
const { app, BrowserWindow, clipboard, dialog, Menu, nativeTheme, shell } = require('electron')
const assert = require('node:assert/strict')
const nodeFs = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const messages = []
let response = 1
let savePath
let openPath
let window
let server
let temporary
const revealedFiles = []
shell.showItemInFolder = (filePath) => revealedFiles.push(filePath)

dialog.showMessageBox = async (_window, options) => {
  messages.push(options)
  return { response, checkboxChecked: false }
}
dialog.showSaveDialog = async () => ({ canceled: !savePath, filePath: savePath })
dialog.showOpenDialog = async () => ({ canceled: !openPath, filePaths: openPath ? [openPath] : [] })

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

async function evaluateIn(targetWindow, code) {
  return targetWindow.webContents.executeJavaScript(code, true)
}

async function untilIn(targetWindow, code, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluateIn(targetWindow, code)) return
    await delay(50)
  }
  throw new Error(`Timed out: ${description}`)
}

function menuItem(label, menu = Menu.getApplicationMenu()) {
  for (const item of menu.items) {
    if (item.label === label) return item
    const nested = item.submenu && menuItem(label, item.submenu)
    if (nested) return nested
  }
}

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
      shortcutDefinitions: module.exports.SHORTCUT_DEFINITIONS,
      keyboardShortcuts: module.exports.KEYBOARD_SHORTCUTS
    })
  )
}

const commandRegistry = loadCommandRegistry()

async function click(label) {
  const item = menuItem(label)
  assert.ok(item, `Menu: ${label}`)
  item.click(item, window)
  await delay(150)
}

async function clickSubmenu(parentLabel, childLabel) {
  const parent = menuItem(parentLabel)
  assert.ok(parent?.submenu, `Menu submenu: ${parentLabel}`)
  const item = parent.submenu.items.find((entry) => entry.label === childLabel)
  assert.ok(item, `Menu: ${parentLabel} > ${childLabel}`)
  item.click(item, window)
  await delay(150)
}

async function setText(text) {
  await evaluate(`editor.setValue(${JSON.stringify(text)})`)
  await delay(250)
}

function inspectorValueExpression(sectionId, label) {
  const selector = `#${sectionId} dt`
  return `(() => {
    const terms = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const term = terms.find((node) => node.textContent === ${JSON.stringify(label)})
    return term?.nextElementSibling?.textContent ?? ''
  })()`
}

async function inspectorValue(sectionId, label) {
  return evaluate(inspectorValueExpression(sectionId, label))
}

async function setLineFilterControls({
  query,
  regex = false,
  caseSensitive = false,
  invert = false
}) {
  await evaluate(`(() => {
    const query = document.getElementById('line-filter-query')
    const regex = document.getElementById('line-filter-regex')
    const caseSensitive = document.getElementById('line-filter-case')
    const invert = document.getElementById('line-filter-invert')

    query.value = ${JSON.stringify(query)}
    regex.checked = ${regex}
    caseSensitive.checked = ${caseSensitive}
    invert.checked = ${invert}
    query.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)

  await delay(250)
}

async function setRegexExtractControls({ pattern, caseSensitive = false, captureGroup = 0 }) {
  await evaluate(`(() => {
    const pattern = document.getElementById('regex-extract-pattern')
    const caseSensitive = document.getElementById('regex-extract-case')
    const captureGroup = document.getElementById('regex-extract-group')

    pattern.value = ${JSON.stringify(pattern)}
    caseSensitive.checked = ${caseSensitive}
    captureGroup.value = ${JSON.stringify(String(captureGroup))}

    pattern.dispatchEvent(new Event('input', { bubbles: true }))
    caseSensitive.dispatchEvent(new Event('change', { bubbles: true }))
    captureGroup.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)

  await delay(250)
}

async function press(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await delay(150)
}

async function untilMenuItem(label, predicate, description, timeout = 6000) {
  const started = Date.now()

  while (Date.now() - started < timeout) {
    const item = menuItem(label)
    if (item && predicate(item)) return item
    await delay(50)
  }

  assert.fail(`Timed out waiting for menu state: ${description}`)
}

async function run() {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'monaco-notepad-runtime-'))
  const fakeBin = path.join(temporary, 'bin')
  const terminalMarker = path.join(temporary, 'terminal-directory.txt')
  await fs.mkdir(fakeBin)
  await fs.writeFile(
    path.join(fakeBin, 'x-terminal-emulator'),
    `#!/bin/sh\npwd > ${JSON.stringify(terminalMarker)}\n`
  )
  await fs.chmod(path.join(fakeBin, 'x-terminal-emulator'), 0o755)
  process.env.PATH = `${fakeBin}:${process.env.PATH}`
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

  await until(
    `!!window.api && performance.getEntriesByType('resource').some(e => /monaco-editor.*editor.*api/.test(e.name))`,
    'editor module'
  )
  await evaluate(`(async () => {
    const url = performance.getEntriesByType('resource').find(e => /monaco-editor.*editor.*api/.test(e.name)).name;
    window.monaco = await import(url);
    window.editor = monaco.editor.getEditors()[0];
  })()`)
  await until(`!!window.editor`, 'editor startup')
  await delay(500)
  const prefs = window.webContents.getLastWebPreferences()
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.sandbox, true)

  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'light')
  assert.equal(nativeTheme.themeSource, 'light')

  await evaluate(`window.api.openPreferencesDialog()`)

  let preferencesWindow
  for (let attempt = 0; attempt < 120; attempt++) {
    preferencesWindow = BrowserWindow.getAllWindows().find((candidate) => candidate !== window)
    if (preferencesWindow && !preferencesWindow.webContents.isLoading()) break
    await delay(50)
  }

  assert.ok(preferencesWindow, 'Preferences window')
  await untilIn(
    preferencesWindow,
    `document.documentElement.dataset.theme === 'light'`,
    'Preferences initial light theme'
  )

  await evaluateIn(
    preferencesWindow,
    `(() => {
      const input = document.querySelector('input[name="theme"][value="dark"]')
      input.checked = true
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })()`
  )

  await until(`document.documentElement.dataset.theme === 'dark'`, 'main dark theme')
  await untilIn(
    preferencesWindow,
    `document.documentElement.dataset.theme === 'dark'`,
    'Preferences dark theme'
  )
  assert.equal(nativeTheme.themeSource, 'dark')
  assert.equal(menuItem('Dark').checked, true)

  await click('Light')
  await until(`document.documentElement.dataset.theme === 'light'`, 'main light theme')
  await untilIn(
    preferencesWindow,
    `document.documentElement.dataset.theme === 'light'`,
    'Preferences light theme'
  )
  await untilIn(
    preferencesWindow,
    `document.querySelector('input[name="theme"][value="light"]').checked`,
    'Preferences light theme radio'
  )
  assert.equal(nativeTheme.themeSource, 'light')

  preferencesWindow.close()
  await delay(150)

  console.log('PASS synchronized main, Preferences, native, and menu themes')

  assert.equal(commandRegistry.shortcutDefinitions.length, 28)

  for (const shortcut of commandRegistry.shortcutDefinitions) {
    const label = shortcut.menuLabel ?? shortcut.label
    const item = menuItem(label)

    assert.ok(item, `Shortcut menu item: ${shortcut.id}`)
    assert.equal(item.accelerator, shortcut.accelerator, `Shortcut accelerator: ${shortcut.id}`)

    if (shortcut.registerAccelerator === false) {
      assert.equal(item.registerAccelerator, false, `Shortcut registration policy: ${shortcut.id}`)
    }
  }

  console.log('PASS native menu shortcut registry contract')

  const initialRecentMenu = menuItem('Recent Files')
  assert.ok(initialRecentMenu?.submenu, 'Recent Files submenu')
  assert.deepEqual(
    initialRecentMenu.submenu.items
      .filter((item) => item.type !== 'separator')
      .map((item) => item.label),
    ['(Empty)', 'Clear Recent Files']
  )
  assert.equal(
    initialRecentMenu.submenu.items.find((item) => item.label === 'Clear Recent Files')?.enabled,
    false
  )

  const recentFixturePaths = Array.from({ length: 11 }, (_, index) =>
    path.join(temporary, `recent-${index}.txt`)
  )

  for (const [index, filePath] of recentFixturePaths.entries()) {
    await fs.writeFile(filePath, `recent ${index}`)
  }

  const missingRecentPath = path.join(temporary, 'recent-missing.txt')
  const pollutedRecentFiles = [
    recentFixturePaths[3],
    missingRecentPath,
    recentFixturePaths[1],
    recentFixturePaths[3],
    recentFixturePaths[0],
    recentFixturePaths[2],
    recentFixturePaths[4],
    recentFixturePaths[5],
    recentFixturePaths[6],
    recentFixturePaths[7],
    recentFixturePaths[8],
    recentFixturePaths[9],
    recentFixturePaths[10]
  ]

  const expectedRecentFiles = [
    recentFixturePaths[3],
    recentFixturePaths[1],
    recentFixturePaths[0],
    recentFixturePaths[2],
    recentFixturePaths[4],
    recentFixturePaths[5],
    recentFixturePaths[6],
    recentFixturePaths[7],
    recentFixturePaths[8],
    recentFixturePaths[9]
  ]

  await evaluate(`(async () => {
    await window.api.preferences.set(
      'recentFiles',
      ${JSON.stringify(pollutedRecentFiles)}
    )
    await window.api.preferences.set(
      'lastDocumentPath',
      ${JSON.stringify(recentFixturePaths[0])}
    )

    // This existing menu-backed preference triggers installMenu(), which
    // exercises normalization of the persisted Recent Files state.
    // Keep its existing default value so the test does not alter editor behavior.
    await window.api.preferences.set('showWhitespace', false)
  })()`)

  await delay(150)

  const normalizedRecentMenu = menuItem('Recent Files')
  assert.ok(normalizedRecentMenu?.submenu, 'normalized Recent Files submenu')

  assert.deepEqual(
    normalizedRecentMenu.submenu.items
      .filter((item) => item.type !== 'separator' && item.label !== 'Clear Recent Files')
      .map((item) => item.label),
    expectedRecentFiles
  )

  assert.equal(
    normalizedRecentMenu.submenu.items.find((item) => item.label === 'Clear Recent Files')?.enabled,
    true
  )

  const normalizedRecentPreferences = JSON.parse(
    await fs.readFile(path.join(temporary, 'profile', 'config.json'), 'utf8')
  )

  assert.deepEqual(normalizedRecentPreferences.recentFiles, expectedRecentFiles)
  assert.equal(normalizedRecentPreferences.lastDocumentPath, recentFixturePaths[0])

  await clickSubmenu('Recent Files', 'Clear Recent Files')

  const clearedRecentMenu = menuItem('Recent Files')
  assert.ok(clearedRecentMenu?.submenu, 'cleared Recent Files submenu')

  assert.deepEqual(
    clearedRecentMenu.submenu.items
      .filter((item) => item.type !== 'separator')
      .map((item) => item.label),
    ['(Empty)', 'Clear Recent Files']
  )

  assert.equal(
    clearedRecentMenu.submenu.items.find((item) => item.label === 'Clear Recent Files')?.enabled,
    false
  )

  const clearedRecentPreferences = JSON.parse(
    await fs.readFile(path.join(temporary, 'profile', 'config.json'), 'utf8')
  )

  assert.deepEqual(clearedRecentPreferences.recentFiles, [])
  assert.equal(
    clearedRecentPreferences.lastDocumentPath,
    recentFixturePaths[0],
    'clearing Recent Files must not clear Reopen Last Document state'
  )

  console.log(
    'PASS Recent Files normalization, missing pruning, deduplication, cap, and clear state'
  )

  await setText('middle-click source')
  await evaluate(`editor.setSelection(new monaco.Selection(1, 1, 1, 7))`)
  await evaluate(`window.api.setPrimarySelection('paste')`)
  await evaluate(
    `document.getElementById('editor').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))`
  )
  await until(`editor.getValue() === 'paste-click source'`, 'primary-selection middle-click paste')

  assert.equal(menuItem('Follow File').checked, false)
  assert.equal(menuItem('Follow File').enabled, false)
  assert.equal(menuItem('Read Only').checked, false)
  assert.equal(menuItem('Read Only').enabled, true)

  await click('Follow File')
  assert.match(
    await evaluate(`document.getElementById('transient-status').innerText`),
    /requires a saved file/
  )

  await click('Document Inspector...')
  await until(
    `!document.getElementById('document-inspector-dialog').hidden`,
    'untitled document inspector open'
  )
  assert.equal(await inspectorValue('document-inspector-disk', 'Saved source'), 'Not saved to disk')
  assert.equal(await inspectorValue('document-inspector-editor', 'Document'), 'Untitled')
  assert.equal(await inspectorValue('document-inspector-editor', 'Dirty'), 'Yes')
  assert.equal(await inspectorValue('document-inspector-editor', 'Current encoding'), 'UTF-8')
  assert.equal(await inspectorValue('document-inspector-editor', 'Saved encoding'), 'UTF-8')
  assert.equal(await evaluate(`document.activeElement?.id`), 'document-inspector-refresh')
  await evaluate(`document.getElementById('document-inspector-close').click()`)
  await until(
    `document.getElementById('document-inspector-dialog').hidden && editor.hasTextFocus()`,
    'untitled inspector close focus restore'
  )

  await click('Document Inspector...')
  await until(
    `!document.getElementById('document-inspector-dialog').hidden`,
    'Document Inspector open for Escape test'
  )
  await evaluate(`
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
    )
  `)
  await until(
    `document.getElementById('document-inspector-dialog').hidden && editor.hasTextFocus()`,
    'Document Inspector Escape and focus restore'
  )

  await click('Document Inspector...')
  await until(
    `!document.getElementById('document-inspector-dialog').hidden`,
    'Document Inspector open for backdrop test'
  )
  await evaluate(
    `document.querySelector('#document-inspector-dialog .modal-overlay[data-close-modal]').click()`
  )
  await until(
    `document.getElementById('document-inspector-dialog').hidden && editor.hasTextFocus()`,
    'Document Inspector backdrop and focus restore'
  )

  await click('Keyboard Shortcuts')
  await until(
    `!document.getElementById('shortcuts-dialog').hidden`,
    'Keyboard Shortcuts open for modal exclusion test'
  )
  await click('Document Inspector...')
  await until(
    `!document.getElementById('document-inspector-dialog').hidden &&
      document.getElementById('shortcuts-dialog').hidden`,
    'Document Inspector replaces Keyboard Shortcuts modal'
  )
  await evaluate(`document.getElementById('document-inspector-close').click()`)
  await until(
    `document.getElementById('document-inspector-dialog').hidden && editor.hasTextFocus()`,
    'modal exclusion inspector close focus restore'
  )

  console.log(
    'PASS Document Inspector modal Close, Escape, backdrop, mutual exclusion, and focus restore'
  )

  console.log('PASS Linux primary selection and middle-click paste')

  await setText('{"a":[1,true]}')
  await evaluate(`editor.setPosition({lineNumber: 1, column: 1})`)
  await click('Format JSON')
  await until(
    `editor.getValue() === '{\\n    "a": [\\n        1,\\n        true\\n    ]\\n}' &&
      editor.getModel().canUndo()`,
    'formatted JSON and undo availability'
  )
  await click('Undo')
  await until(`editor.getValue() === '{"a":[1,true]}'`, 'undo formatted JSON')
  await setText('one two')
  await evaluate(
    `editor.setSelections([new monaco.Selection(1,1,1,4), new monaco.Selection(1,5,1,8)])`
  )
  await click('Base64 Encode')
  assert.equal(await evaluate('editor.getValue()'), 'b25l dHdv')
  await click('Undo')
  await until(`editor.getValue() === 'one two'`, 'undo Base64 encode')
  await setText('b25l %%%%')
  await evaluate(
    `editor.setSelections([new monaco.Selection(1,1,1,5), new monaco.Selection(1,6,1,10)])`
  )
  await click('Base64 Decode')
  assert.equal(await evaluate('editor.getValue()'), 'b25l %%%%')
  await setText('prefix {"a":1} suffix')
  await evaluate(`editor.setSelection(new monaco.Selection(1,8,1,15))`)
  await click('Format JSON')
  assert.equal(await evaluate('editor.getValue()'), 'prefix {\n    "a": 1\n} suffix')
  await until(
    `editor.getModel().canUndo() && editor.getSelection()?.endLineNumber === 3`,
    'selected JSON transform undo ready'
  )
  await click('Undo')
  await until(
    `editor.getValue() === 'prefix {"a":1} suffix' && editor.getModel().canRedo()`,
    'undo selected JSON format'
  )
  await setText('{bad}')
  await evaluate(`editor.setPosition({lineNumber: 1, column: 1})`)
  await click('Format JSON')
  assert.equal(await evaluate('editor.getValue()'), '{bad}')
  await setText('abc')
  await evaluate(`editor.setSelection(new monaco.Selection(1,1,1,4))`)
  await click('Read Only')
  await untilMenuItem(
    'Read Only',
    (item) => item.checked && item.enabled,
    'voluntary Read Only checked and toggleable'
  )

  for (const label of [
    'Delete',
    'Duplicate Line',
    'Indent Selection',
    'UPPERCASE',
    'Base64 Encode',
    'Trim Trailing Whitespace',
    'Toggle Line Comment',
    'Toggle Bookmark',
    'Clear All Bookmarks',
    'Time/Date',
    'Add Final Newline'
  ]) {
    assert.equal(menuItem(label).enabled, false, `${label} disabled while read-only`)
  }

  assert.equal(menuItem('Find...').enabled, true)
  assert.equal(menuItem('SHA-256 (Copy)').enabled, true)

  await click('Base64 Encode')
  assert.equal(await evaluate('editor.getValue()'), 'abc')
  const expectedReadOnlySha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  clipboard.writeText('')
  await click('SHA-256 (Copy)')
  for (let attempt = 0; attempt < 40; attempt++) {
    if (clipboard.readText() === expectedReadOnlySha256) break
    await delay(50)
  }
  assert.equal(clipboard.readText(), expectedReadOnlySha256)
  await click('Read Only')
  await untilMenuItem(
    'Read Only',
    (item) => !item.checked && item.enabled,
    'voluntary Read Only cleared and toggleable'
  )
  await until(
    `document.getElementById('transient-status').innerText === 'Read-only disabled' &&
      !document.getElementById('transient-status').hidden`,
    'Read Only disabled transient feedback'
  )

  for (const label of [
    'Delete',
    'Duplicate Line',
    'Indent Selection',
    'UPPERCASE',
    'Base64 Encode',
    'Trim Trailing Whitespace',
    'Toggle Line Comment',
    'Toggle Bookmark',
    'Clear All Bookmarks',
    'Time/Date',
    'Add Final Newline'
  ]) {
    assert.equal(menuItem(label).enabled, true, `${label} restored after read-only`)
  }

  console.log('PASS transforms, atomic multi-selection, one-step undo, and read-only hashing')

  await setText('hello world\nsecond line 😀')
  await click('Show Whitespace')
  assert.equal(
    await evaluate(`editor.getOption(monaco.editor.EditorOption.renderWhitespace)`),
    'all'
  )
  assert.equal(
    await evaluate(`editor.getOption(monaco.editor.EditorOption.renderControlCharacters)`),
    true
  )
  await click('Show Line Numbers')
  assert.ok(await evaluate(`editor.getLayoutInfo().contentLeft > 20`))
  await click('Show Line Numbers')
  assert.equal(await evaluate(`editor.getLayoutInfo().contentLeft`), 10)
  await press('F9', ['control', 'shift'])
  assert.ok(await evaluate(`editor.getLayoutInfo().contentLeft > 20`))
  await press('F9', ['control', 'shift'])
  assert.equal(await evaluate(`editor.getLayoutInfo().contentLeft`), 10)
  console.log('PASS preferences, whitespace, collapsed gutter, security')

  await click('Keyboard Shortcuts')
  await until(
    `!document.getElementById('shortcuts-dialog').hidden`,
    'Keyboard Shortcuts dialog open for Close test'
  )
  assert.equal(
    await evaluate(
      `document.activeElement === document.querySelector('#shortcuts-dialog button[data-close-modal]')`
    ),
    true
  )

  const shortcutRows = await evaluate(`
    [...document.querySelectorAll('#shortcuts-list li')].map((item) => ({
      label: item.querySelector('span')?.textContent ?? '',
      accelerator: item.querySelector('kbd')?.textContent ?? ''
    }))
  `)

  assert.deepEqual(shortcutRows, commandRegistry.keyboardShortcuts)
  await evaluate(`document.querySelector('#shortcuts-dialog button[data-close-modal]').click()`)
  await until(
    `document.getElementById('shortcuts-dialog').hidden && editor.hasTextFocus()`,
    'Keyboard Shortcuts Close button and focus restore'
  )

  await click('Keyboard Shortcuts')
  await until(
    `!document.getElementById('shortcuts-dialog').hidden`,
    'Keyboard Shortcuts dialog open for Escape test'
  )
  await evaluate(`
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
    )
  `)
  await until(
    `document.getElementById('shortcuts-dialog').hidden && editor.hasTextFocus()`,
    'Keyboard Shortcuts Escape and focus restore'
  )

  await click('Keyboard Shortcuts')
  await until(
    `!document.getElementById('shortcuts-dialog').hidden`,
    'Keyboard Shortcuts dialog open for backdrop test'
  )
  await evaluate(
    `document.querySelector('#shortcuts-dialog .modal-overlay[data-close-modal]').click()`
  )
  await until(
    `document.getElementById('shortcuts-dialog').hidden && editor.hasTextFocus()`,
    'Keyboard Shortcuts backdrop and focus restore'
  )

  console.log('PASS Keyboard Shortcuts open, focus, Close, Escape, and backdrop dismissal')

  await evaluate(`editor.setSelection(new monaco.Selection(1, 1, 1, 6))`)
  await click('UPPERCASE')
  assert.equal(await evaluate(`editor.getModel().getLineContent(1)`), 'HELLO world')
  await click('Undo')
  assert.equal(await evaluate(`editor.getModel().getLineContent(1)`), 'hello world')
  await click('Title Case')
  assert.equal(await evaluate(`editor.getModel().getLineContent(1)`), 'Hello world')
  await click('lowercase')
  assert.equal(await evaluate(`editor.getModel().getLineContent(1)`), 'hello world')

  assert.equal(await evaluate(`document.getElementById('statusbar').style.display`), 'none')
  assert.equal(
    await evaluate(`document.getElementById('editor').classList.contains('hide-line-numbers')`),
    true
  )
  await click('Status Bar')
  await until(`document.getElementById('statusbar').style.display !== 'none'`, 'status bar enable')
  const status = await evaluate(`document.getElementById('statusbar').innerText`)
  assert.match(status, /Words\s*5/)
  assert.match(status, /Chars\s*25/)
  assert.match(status, /Selected\s*5/)
  console.log('PASS selected case conversion, undo, text statistics')

  await setText('one\ntwo\nthree')
  await evaluate(`editor.setPosition({lineNumber: 1, column: 1})`)
  await click('Toggle Bookmark')
  await evaluate(`editor.setPosition({lineNumber: 3, column: 1})`)
  await click('Toggle Bookmark')
  await click('Next Bookmark')
  assert.equal(await evaluate('editor.getPosition().lineNumber'), 1)
  await click('Previous Bookmark')
  assert.equal(await evaluate('editor.getPosition().lineNumber'), 3)
  await click('Clear All Bookmarks')
  await click('Next Bookmark')
  assert.equal(await evaluate('editor.getPosition().lineNumber'), 3)
  await evaluate(`editor.setPosition({lineNumber: 2, column: 1})`)
  await click('Duplicate Line')
  assert.equal(await evaluate('editor.getModel().getLineCount()'), 4)
  await click('Move Line Up')
  await click('Move Line Down')
  await evaluate(`editor.setSelection(new monaco.Selection(1, 1, 2, 1))`)
  await click('Indent Selection')
  assert.match(await evaluate(`editor.getModel().getLineContent(1)`), /^\s+/)
  await click('Outdent Selection')
  console.log('PASS bookmarks and built-in line operations')

  await setText('beta  \n\talpha\t\n\nalpha')
  await click('Trim Trailing Whitespace')
  assert.equal(await evaluate('editor.getValue()'), 'beta\n\talpha\n\nalpha')
  await click('Undo')
  await until(
    `editor.getValue() === 'beta  \\n\\talpha\\t\\n\\nalpha'`,
    'Trim Trailing Whitespace undo restoration'
  )
  await click('Convert Tabs to Spaces')
  assert.equal(await evaluate('editor.getModel().getLineContent(2)'), '    alpha    ')
  await click('Convert Spaces to Tabs')
  assert.equal(await evaluate('editor.getModel().getLineContent(2)'), '\talpha    ')
  await evaluate(`editor.setSelection(new monaco.Selection(1, 1, 4, 6))`)
  await click('Sort Lines Ascending')
  assert.equal(await evaluate('editor.getValue()'), '\n\talpha    \nalpha\nbeta  ')
  await click('Sort Lines Descending')
  assert.equal(await evaluate('editor.getValue()'), 'beta  \nalpha\n\talpha    \n')
  await setText('one\ntwo\none\n \nthree')
  await evaluate(`editor.setSelection(new monaco.Selection(1, 1, 5, 6))`)
  await click('Remove Duplicate Lines')
  assert.equal(await evaluate('editor.getValue()'), 'one\ntwo\n \nthree')
  await click('Delete Empty Lines')
  assert.equal(await evaluate('editor.getValue()'), 'one\ntwo\nthree')
  await evaluate(`editor.setPosition({lineNumber: 2, column: 2})`)
  await click('Select Current Line')
  assert.equal(await evaluate('editor.getSelection().isEmpty()'), false)
  await evaluate(
    `monaco.editor.setModelLanguage(editor.getModel(), 'javascript'); editor.setValue('const x = (1);')`
  )
  await delay(300)
  await evaluate(`editor.setPosition({lineNumber: 1, column: 11})`)
  await click('Go to Matching Bracket')
  assert.equal(await evaluate('editor.getPosition().column'), 13)
  await click('Toggle Line Comment')
  assert.match(await evaluate('editor.getValue()'), /^\/\//)
  await evaluate(
    `editor.setSelections([new monaco.Selection(1,1,1,1), new monaco.Selection(1,3,1,3)])`
  )
  assert.equal(await evaluate('editor.getSelections().length'), 2)
  console.log('PASS V1.1 text utilities, Monaco actions, undo, and multicursor')

  await click('8')
  await click('Insert Literal Tabs')
  await click('Basic Auto Indent')
  await click('Trim Trailing Whitespace on Save')
  assert.equal(await evaluate(`editor.getModel().getOptions().tabSize`), 8)
  assert.equal(await evaluate(`editor.getModel().getOptions().insertSpaces`), false)
  assert.equal(await evaluate(`editor.getOption(monaco.editor.EditorOption.autoIndent)`), 4)

  savePath = path.join(temporary, 'saved.txt')
  await click('Save As...')
  await until(`!document.title.startsWith('*')`, 'save as')
  assert.equal(await fs.readFile(savePath, 'utf8'), await evaluate('editor.getValue()'))

  await evaluate(`(() => {
    const encoding = document.getElementById('encoding')
    encoding.value = 'utf16le'
    encoding.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(
    `document.getElementById('encoding').value === 'utf16le' && document.title.startsWith('*')`,
    'current encoding differs from saved encoding'
  )

  await click('Document Inspector...')
  await until(
    `document.getElementById('document-inspector-disk').innerText.includes('Scan encoding')`,
    'encoding inspector disk snapshot'
  )
  assert.equal(await inspectorValue('document-inspector-editor', 'Dirty'), 'Yes')
  assert.equal(await inspectorValue('document-inspector-editor', 'Current encoding'), 'UTF-16 LE')
  assert.equal(await inspectorValue('document-inspector-editor', 'Saved encoding'), 'UTF-8')
  assert.equal(await inspectorValue('document-inspector-disk', 'Scan encoding'), 'UTF-8')
  await evaluate(`document.getElementById('document-inspector-close').click()`)
  await until(
    `document.getElementById('document-inspector-dialog').hidden && editor.hasTextFocus()`,
    'encoding inspector close focus restore'
  )

  await evaluate(`(() => {
    const encoding = document.getElementById('encoding')
    encoding.value = 'utf8'
    encoding.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(
    `document.getElementById('encoding').value === 'utf8' && !document.title.startsWith('*')`,
    'restore saved UTF-8 encoding'
  )

  await setText('trimmed on save   ')
  await click('Save')
  assert.equal(await fs.readFile(savePath, 'utf8'), 'trimmed on save')
  assert.match(await evaluate(`document.getElementById('file-size').innerText`), /15 B/)
  await click('Undo')
  assert.equal(await evaluate('editor.getValue()'), 'trimmed on save   ')
  await click('Redo')

  const preBackupSaveText = await fs.readFile(savePath, 'utf8')
  await evaluate(`window.api.preferences.set('backupOnSave', true)`)
  await until(
    `window.api.preferences.getAll().then((preferences) => preferences.backupOnSave === true)`,
    'backup-on-save preference enabled'
  )
  await setText('backup-enabled save')
  await click('Save')
  await until(`!document.title.startsWith('*')`, 'backup-enabled ordinary save')
  assert.equal(await fs.readFile(savePath, 'utf8'), 'backup-enabled save')
  assert.equal(await fs.readFile(`${savePath}.bak`, 'utf8'), preBackupSaveText)

  const encodingSaveSample = 'café £ €'
  const utf16LeBody = Buffer.from(encodingSaveSample, 'utf16le')
  const utf16BeBody = Buffer.from(utf16LeBody)

  for (let index = 0; index < utf16BeBody.length; index += 2) {
    const low = utf16BeBody[index]
    utf16BeBody[index] = utf16BeBody[index + 1]
    utf16BeBody[index + 1] = low
  }

  const expectedEncodingBytes = new Map([
    ['utf8', Buffer.from(encodingSaveSample, 'utf8')],
    [
      'utf8-bom',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encodingSaveSample, 'utf8')])
    ],
    ['utf16le', Buffer.concat([Buffer.from([0xff, 0xfe]), utf16LeBody])],
    ['utf16be', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BeBody])],
    ['windows1252', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xa3, 0x20, 0x80])]
  ])

  await setText(encodingSaveSample)

  for (const [encoding, expectedBytes] of expectedEncodingBytes) {
    await evaluate(`(() => {
      const control = document.getElementById('encoding')
      control.value = ${JSON.stringify(encoding)}
      control.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await click('Save')
    await until(`!document.title.startsWith('*')`, `${encoding} encoding save`)
    assert.deepEqual(await fs.readFile(savePath), expectedBytes, encoding)
  }

  await evaluate(`(() => {
    const control = document.getElementById('encoding')
    control.value = 'utf8'
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await setText('Hello 世界')
  await click('Save')
  await until(`!document.title.startsWith('*')`, 'Unicode baseline save before ANSI rejection')
  const unicodeBaselineBytes = await fs.readFile(savePath)
  const saveErrorsBeforeAnsiRejection = messages.filter(
    (message) => message.title === 'Save Error'
  ).length

  await evaluate(`(() => {
    const control = document.getElementById('encoding')
    control.value = 'windows1252'
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await click('Save')
  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      messages.filter((message) => message.title === 'Save Error').length >
      saveErrorsBeforeAnsiRejection
    ) {
      break
    }
    await delay(50)
  }
  assert.ok(
    messages.filter((message) => message.title === 'Save Error').length >
      saveErrorsBeforeAnsiRejection
  )
  const ansiSaveError = [...messages].reverse().find((message) => message.title === 'Save Error')
  assert.match(ansiSaveError?.detail ?? '', /cannot be represented/)
  assert.deepEqual(await fs.readFile(savePath), unicodeBaselineBytes)
  assert.equal(await evaluate(`document.title.startsWith('*')`), true)
  assert.equal(await evaluate(`document.getElementById('encoding').value`), 'windows1252')

  await evaluate(`(() => {
    const control = document.getElementById('encoding')
    control.value = 'utf8'
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(`!document.title.startsWith('*')`, 'restore saved UTF-8 after ANSI rejection')
  await setText('backup-enabled save')
  await click('Save')
  await until(`!document.title.startsWith('*')`, 'encoding matrix state restore')
  assert.equal(await fs.readFile(savePath, 'utf8'), 'backup-enabled save')
  console.log('PASS exact save bytes for all encodings and lossless ANSI rejection')

  const statusBarDisplayBeforeNotificationTest = await evaluate(
    `document.getElementById('statusbar').style.display`
  )

  if (statusBarDisplayBeforeNotificationTest === 'none') {
    await click('Status Bar')
    await until(
      `document.getElementById('statusbar').style.display !== 'none'`,
      'status bar visible for transient positioning'
    )
  }

  await click('Copy Full Path')
  await until(
    `document.getElementById('transient-status').innerText === 'Path copied' &&
      !document.getElementById('transient-status').hidden`,
    'Path copied transient feedback'
  )
  assert.equal(clipboard.readText(), savePath)
  assert.equal(
    await evaluate(`document.getElementById('transient-status').parentElement?.id === 'statusbar'`),
    false
  )
  assert.equal(
    await evaluate(`(() => {
      const transient = document.getElementById('transient-status').getBoundingClientRect()
      const statusbar = document.getElementById('statusbar').getBoundingClientRect()
      return transient.bottom <= statusbar.top
    })()`),
    true,
    'transient feedback must sit above the visible status bar'
  )

  await click('Status Bar')
  await until(
    `document.getElementById('statusbar').style.display === 'none'`,
    'status bar hidden for transient feedback'
  )

  await click('Copy Filename')
  await until(
    `document.getElementById('transient-status').innerText === 'Filename copied' &&
      !document.getElementById('transient-status').hidden`,
    'Filename copied transient feedback'
  )
  assert.equal(clipboard.readText(), path.basename(savePath))
  assert.notEqual(
    await evaluate(`getComputedStyle(document.getElementById('transient-status')).display`),
    'none'
  )
  assert.equal(
    await evaluate(`getComputedStyle(document.getElementById('transient-status')).bottom`),
    '12px'
  )

  if (statusBarDisplayBeforeNotificationTest !== 'none') {
    await click('Status Bar')
    await until(
      `document.getElementById('statusbar').style.display !== 'none'`,
      'restore visible status bar after transient test'
    )
  }
  await click('Reveal in File Manager')
  assert.deepEqual(revealedFiles, [savePath])
  await click('Open Terminal Here')
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fs.readFile(terminalMarker, 'utf8')).trim() === path.dirname(savePath)) break
    } catch {
      // The detached terminal helper may not have written its marker yet.
    }
    await delay(50)
  }
  assert.equal((await fs.readFile(terminalMarker, 'utf8')).trim(), path.dirname(savePath))
  await click('Document Inspector...')
  await until(
    `!document.getElementById('document-inspector-dialog').hidden`,
    'document inspector open'
  )
  await until(
    `document.getElementById('document-inspector-disk').innerText.includes(${JSON.stringify(savePath)})`,
    'document inspector disk snapshot'
  )
  assert.equal(await inspectorValue('document-inspector-editor', 'Dirty'), 'No')

  await evaluate(`document.getElementById('document-inspector-copy').click()`)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (clipboard.readText().includes(savePath)) break
    await delay(50)
  }

  const inspectorReport = clipboard.readText()
  assert.match(inspectorReport, /Monaco Notepad — Document Inspector/)
  assert.match(inspectorReport, /Disk \/ Saved Source/)
  assert.ok(inspectorReport.includes(`Path: ${savePath}`))
  assert.match(inspectorReport, /Current Editor/)
  assert.match(inspectorReport, /Dirty: No/)
  assert.match(
    await evaluate(`document.getElementById('document-inspector-status').innerText`),
    /copied to clipboard/i
  )

  await evaluate(`document.getElementById('document-inspector-close').click()`)
  await until(
    `document.getElementById('document-inspector-dialog').hidden && editor.hasTextFocus()`,
    'saved inspector close focus restore'
  )
  console.log('PASS Document Inspector encoding and saved report separation')

  response = 0
  clipboard.writeText('')
  await click('SHA-256')
  for (let attempt = 0; attempt < 40; attempt++) {
    if (/^[a-f0-9]{64}$/.test(clipboard.readText())) break
    await delay(50)
  }
  assert.match(clipboard.readText(), /^[a-f0-9]{64}$/)
  const originalTitle = await evaluate('document.title')
  const copyPath = path.join(temporary, 'copy-only.txt')
  await fs.writeFile(copyPath, 'existing copy contents')
  savePath = copyPath
  await click('Save a Copy...')
  assert.equal(await fs.readFile(copyPath, 'utf8'), await evaluate('editor.getValue()'))
  await assert.rejects(fs.access(`${copyPath}.bak`))
  assert.equal(await evaluate('document.title'), originalTitle)
  savePath = path.join(temporary, 'saved.txt')
  await fs.writeFile(savePath, 'disk reload')
  response = 0
  await click('Reload from Disk')
  await until(`editor.getValue() === 'disk reload'`, 'explicit reload')
  await until(
    `document.getElementById('transient-status').innerText === 'Reloaded from disk' &&
      !document.getElementById('transient-status').hidden`,
    'Reloaded from disk transient feedback'
  )

  await setText('dirty edits')
  await fs.writeFile(savePath, 'disk revert')
  response = 1
  await click('Revert to Saved')
  assert.equal(await evaluate('editor.getValue()'), 'dirty edits')

  response = 0
  await click('Revert to Saved')
  await until(`editor.getValue() === 'disk revert'`, 'confirmed revert')
  await until(
    `document.getElementById('transient-status').innerText === 'Reverted to saved file' &&
      !document.getElementById('transient-status').hidden`,
    'Reverted to saved file transient feedback'
  )

  console.log(
    'PASS file utilities, checksum, save copy, reload, guarded revert, and transient feedback'
  )
  const externalChangeMessageCount = () =>
    messages.filter((m) => ['File Changed', 'File Replaced', 'File Removed'].includes(m.title))
      .length
  const fileChangeMessagesBeforeSelfSave = externalChangeMessageCount()
  await setText('saved again')
  await click('Save')
  await delay(400)
  assert.equal(await fs.readFile(savePath, 'utf8'), 'saved again')
  assert.equal(externalChangeMessageCount(), fileChangeMessagesBeforeSelfSave)
  const replacement = path.join(temporary, 'replacement.txt')
  await fs.writeFile(replacement, 'external replacement')
  response = 0
  await fs.rename(replacement, savePath)
  await until(`editor.getValue() === 'external replacement'`, 'atomic external reload')
  assert.equal(externalChangeMessageCount(), fileChangeMessagesBeforeSelfSave + 1)
  await fs.writeFile(replacement, 'second replacement')
  await fs.rename(replacement, savePath)
  await until(`editor.getValue() === 'second replacement'`, 'watch survives replacement')
  await setText('current buffer')
  await fs.writeFile(replacement, 'disk comparison')
  response = 1
  await fs.rename(replacement, savePath)
  await until(
    `!document.getElementById('compare-view').hidden && monaco.editor.getDiffEditors().length === 1`,
    'compare against disk'
  )
  assert.equal(
    await evaluate(`monaco.editor.getDiffEditors()[0].getModel().original.getValue()`),
    'current buffer'
  )
  assert.equal(
    await evaluate(`monaco.editor.getDiffEditors()[0].getModel().modified.getValue()`),
    'disk comparison'
  )
  await until(
    `monaco.editor.getDiffEditors().length === 1 &&
      monaco.editor.getDiffEditors()[0].getLineChanges() !== null`,
    'compare diff computation'
  )
  await evaluate(`document.getElementById('compare-keep').click()`)
  await until(`document.getElementById('compare-view').hidden`, 'close comparison')
  assert.equal(await evaluate('editor.getValue()'), 'current buffer')

  const compareBaselineModelCount = await evaluate(`monaco.editor.getModels().length`)
  assert.equal(await evaluate(`monaco.editor.getDiffEditors().length`), 0)

  for (let cycle = 1; cycle <= 12; cycle++) {
    const compareReplacement = path.join(temporary, `compare-resource-${cycle}.txt`)
    const compareDiskText = cycle === 12 ? 'disk comparison' : `disk comparison ${cycle}`
    await fs.writeFile(compareReplacement, compareDiskText)
    response = 1
    await fs.rename(compareReplacement, savePath)

    await until(
      `!document.getElementById('compare-view').hidden &&
        monaco.editor.getDiffEditors().length === 1 &&
        monaco.editor.getModels().length === ${compareBaselineModelCount + 1}`,
      `compare resource cycle ${cycle} open`
    )

    assert.equal(
      await evaluate(`monaco.editor.getDiffEditors()[0].getModel().modified.getValue()`),
      compareDiskText
    )

    await evaluate(`document.getElementById('compare-keep').click()`)

    await until(
      `document.getElementById('compare-view').hidden &&
        monaco.editor.getDiffEditors().length === 0 &&
        monaco.editor.getModels().length === ${compareBaselineModelCount}`,
      `compare resource cycle ${cycle} cleanup`
    )

    assert.equal(await evaluate('editor.getValue()'), 'current buffer')
  }

  console.log(
    'PASS compare against disk preserves current buffer and returns Monaco resources to baseline'
  )

  const overwriteReplacement = path.join(temporary, 'external-overwrite-target.txt')
  await fs.writeFile(overwriteReplacement, 'external overwrite target')
  response = 3
  await fs.rename(overwriteReplacement, savePath)
  await until(`!document.title.startsWith('*')`, 'explicit external overwrite')
  assert.equal(await fs.readFile(savePath, 'utf8'), 'current buffer')
  const overwritePrompt = [...messages]
    .reverse()
    .find((message) => message.title === 'File Replaced')
  assert.deepEqual(overwritePrompt?.buttons, [
    'Keep Editing',
    'Compare Against Disk',
    'Save As',
    'Overwrite'
  ])
  console.log('PASS dirty external replacement exposes explicit overwrite')

  await setText('deleted path edits')
  const deletedPath = savePath
  const removedPromptsBefore = messages.filter((message) => message.title === 'File Removed').length
  response = 1
  await fs.rm(deletedPath)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      messages.filter((message) => message.title === 'File Removed').length > removedPromptsBefore
    )
      break
    await delay(50)
  }
  const removalPrompt = [...messages].reverse().find((message) => message.title === 'File Removed')
  assert.deepEqual(removalPrompt?.buttons, ['Save As', 'Keep Editing'])
  await assert.rejects(fs.access(deletedPath))
  assert.equal(await evaluate(`document.title.startsWith('*')`), true)

  const removedPromptsBeforeSave = messages.filter(
    (message) => message.title === 'File Removed'
  ).length
  response = 1
  await click('Save')
  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      messages.filter((message) => message.title === 'File Removed').length >
      removedPromptsBeforeSave
    )
      break
    await delay(50)
  }
  await assert.rejects(fs.access(deletedPath))
  assert.equal(await evaluate(`document.title.startsWith('*')`), true)
  const deletedSavePrompt = [...messages]
    .reverse()
    .find((message) => message.title === 'File Removed')
  assert.deepEqual(deletedSavePrompt?.buttons, ['Save As', 'Cancel'])

  savePath = path.join(temporary, 'after-deletion.txt')
  await click('Save As...')
  await until(`!document.title.startsWith('*')`, 'deleted file Save As recovery')
  assert.equal(await fs.readFile(savePath, 'utf8'), 'deleted path edits')
  await assert.rejects(fs.access(deletedPath))
  console.log('PASS deletion keeps buffer safe and ordinary Save cannot silently recreate old path')

  response = 2
  const readOnlyDiskText = await fs.readFile(savePath, 'utf8')
  await fs.chmod(savePath, 0o444)
  await delay(600)
  await evaluate(`window.dispatchEvent(new Event('focus'))`)
  await delay(200)
  assert.match(await evaluate(`document.getElementById('statusbar').innerText`), /Read Only/)
  await untilMenuItem(
    'Read Only',
    (item) => item.checked && !item.enabled,
    'filesystem Read Only checked and non-toggleable'
  )
  assert.equal(menuItem('Delete').enabled, false)
  assert.equal(menuItem('Base64 Encode').enabled, false)

  await setText('read only edits')
  await click('Save')
  assert.equal(await fs.readFile(savePath, 'utf8'), readOnlyDiskText)
  assert.equal(await evaluate(`document.title.startsWith('*')`), true)
  assert.ok(messages.some((m) => m.title === 'Save Error'))
  savePath = path.join(temporary, 'writable-copy.txt')
  await click('Save As...')
  await until(`!document.title.startsWith('*')`, 'read-only save as')
  assert.equal(await fs.readFile(savePath, 'utf8'), 'read only edits')
  await untilMenuItem(
    'Read Only',
    (item) => !item.checked && item.enabled,
    'Save As restored editable native menu state'
  )
  assert.equal(menuItem('Delete').enabled, true)
  assert.equal(menuItem('Base64 Encode').enabled, true)

  console.log(
    'PASS save, self-save suppression, repeated external replacement, read-only guard, Save As'
  )

  const reopenEncodingPath = path.join(temporary, 'reopen-encoding.txt')
  await fs.writeFile(reopenEncodingPath, 'café', 'utf8')
  openPath = reopenEncodingPath
  response = 0
  await click('Open...')
  await until(
    `document.title === 'reopen-encoding.txt - Monaco Notepad' && editor.getValue() === 'café'`,
    'UTF-8 reopen fixture open'
  )
  assert.equal(await evaluate(`document.getElementById('encoding').value`), 'utf8')
  assert.equal(await evaluate(`document.title.startsWith('*')`), false)

  await clickSubmenu('Reopen With Encoding', 'ANSI (Windows-1252)')
  await until(
    `editor.getValue() === 'cafÃ©' && document.getElementById('encoding').value === 'windows1252'`,
    'explicit Windows-1252 reinterpretation'
  )
  assert.equal(await evaluate(`document.title.startsWith('*')`), false)

  await setText('dirty reinterpretation')
  response = 2
  await clickSubmenu('Reopen With Encoding', 'UTF-8')
  assert.equal(await evaluate(`editor.getValue()`), 'dirty reinterpretation')
  assert.equal(await evaluate(`document.getElementById('encoding').value`), 'windows1252')
  assert.equal(await evaluate(`document.title.startsWith('*')`), true)

  response = 1
  await clickSubmenu('Reopen With Encoding', 'UTF-8')
  await until(
    `editor.getValue() === 'café' && document.getElementById('encoding').value === 'utf8'`,
    'confirmed UTF-8 reopen'
  )
  assert.equal(await evaluate(`document.title.startsWith('*')`), false)
  assert.equal(await fs.readFile(reopenEncodingPath, 'utf8'), 'café')
  console.log(
    'PASS Reopen With Encoding explicit reinterpretation, clean state, dirty Cancel, and dirty Discard'
  )

  const mixedEolPath = path.join(temporary, 'mixed-eol.txt')
  const mixedEolOriginal = 'one\r\ntwo\nthree\rfour'
  await fs.writeFile(mixedEolPath, mixedEolOriginal, 'utf8')

  openPath = mixedEolPath
  response = 0
  await click('Open...')
  await until(
    `document.title === 'mixed-eol.txt - Monaco Notepad' && document.getElementById('eol').value === 'Mixed'`,
    'mixed EOL source status'
  )
  assert.equal(await evaluate(`editor.getModel().getEOL()`), '\r\n')
  assert.equal(await evaluate(`document.title.startsWith('*')`), false)

  await click('Document Inspector...')
  await until(
    `!document.getElementById('document-inspector-dialog').hidden`,
    'mixed EOL document inspector open'
  )
  await until(
    `document.getElementById('document-inspector-disk').innerText.includes('Disk EOL')`,
    'mixed EOL disk snapshot'
  )

  const mixedDiskEol = await evaluate(`(() => {
    const terms = [...document.querySelectorAll('#document-inspector-disk dt')]
    const term = terms.find((node) => node.textContent === 'Disk EOL')
    return term?.nextElementSibling?.textContent ?? ''
  })()`)

  const mixedEditorEol = await evaluate(`(() => {
    const terms = [...document.querySelectorAll('#document-inspector-editor dt')]
    const term = terms.find((node) => node.textContent === 'Source EOL')
    return term?.nextElementSibling?.textContent ?? ''
  })()`)

  assert.equal(mixedDiskEol, 'Mixed')
  assert.equal(mixedEditorEol, 'Mixed EOL')
  await evaluate(`document.getElementById('document-inspector-close').click()`)

  await click('Save')
  assert.equal(await fs.readFile(mixedEolPath, 'utf8'), mixedEolOriginal)
  assert.match(
    await evaluate(`document.getElementById('transient-status').innerText`),
    /Normalize.*Mixed EOL.*LF.*CRLF/i
  )

  const blockedMixedSaveAs = path.join(temporary, 'mixed-blocked-save-as.txt')
  savePath = blockedMixedSaveAs
  await click('Save As...')
  await assert.rejects(fs.access(blockedMixedSaveAs))

  const blockedMixedCopy = path.join(temporary, 'mixed-blocked-copy.txt')
  savePath = blockedMixedCopy
  await click('Save a Copy...')
  await assert.rejects(fs.access(blockedMixedCopy))

  // A real Monaco EOL conversion must restore the unresolved source state
  // when undone and restore the normalization intent when redone.
  await click('Normalize to LF')
  await until(
    `document.getElementById('eol').value === 'LF' && document.title.startsWith('*')`,
    'mixed EOL normalize to LF'
  )
  assert.equal(await evaluate(`editor.getModel().getEOL()`), '\n')

  await click('Undo')
  await until(
    `document.getElementById('eol').value === 'Mixed' && !document.title.startsWith('*')`,
    'undo mixed EOL normalization'
  )
  assert.equal(await evaluate(`editor.getModel().getEOL()`), '\r\n')

  await click('Redo')
  await until(
    `document.getElementById('eol').value === 'LF' && document.title.startsWith('*')`,
    'redo mixed EOL normalization'
  )
  assert.equal(await evaluate(`editor.getModel().getEOL()`), '\n')

  await click('Undo')
  await until(
    `document.getElementById('eol').value === 'Mixed' && !document.title.startsWith('*')`,
    'restore unresolved mixed EOL state'
  )
  assert.equal(await evaluate(`editor.getModel().getEOL()`), '\r\n')

  // Monaco already chose CRLF internally for this source. Explicit CRLF
  // normalization therefore has no model edit, but it must still make the
  // document dirty and permit a deliberate normalized save.
  await click('Normalize to CRLF')
  await until(
    `document.getElementById('eol').value === 'CRLF' && document.title.startsWith('*')`,
    'same-model mixed EOL normalization intent'
  )
  assert.equal(await evaluate(`editor.getModel().getEOL()`), '\r\n')

  // Ordinary content Undo must not discard a metadata-only normalization.
  const sameModelNormalizedText = await evaluate(`editor.getValue()`)
  await evaluate(
    `editor.executeEdits('runtime-eol', [{
      range: new monaco.Range(1, 1, 1, 1),
      text: 'X'
    }])`
  )
  await click('Undo')
  await until(
    `editor.getValue() === ${JSON.stringify(sameModelNormalizedText)}`,
    'undo text edit after same-model EOL normalization'
  )
  assert.equal(await evaluate(`document.getElementById('eol').value`), 'CRLF')
  assert.equal(await evaluate(`document.title.startsWith('*')`), true)

  await click('Save')
  await until(`!document.title.startsWith('*')`, 'normalized mixed EOL save')
  assert.equal(await fs.readFile(mixedEolPath, 'utf8'), 'one\r\ntwo\r\nthree\r\nfour')

  const crEolPath = path.join(temporary, 'cr-eol.txt')
  await fs.writeFile(crEolPath, 'one\rtwo\rthree', 'utf8')

  openPath = crEolPath
  response = 0
  await click('Open...')
  await until(
    `document.title === 'cr-eol.txt - Monaco Notepad' && document.getElementById('eol').value === 'CR'`,
    'CR source status'
  )
  assert.equal(await evaluate(`editor.getModel().getEOL()`), '\n')
  assert.equal(await evaluate(`document.title.startsWith('*')`), false)

  await click('Normalize to LF')
  await until(
    `document.getElementById('eol').value === 'LF' && document.title.startsWith('*')`,
    'same-model CR normalization intent'
  )
  await click('Save')
  await until(`!document.title.startsWith('*')`, 'normalized CR save')
  assert.equal(await fs.readFile(crEolPath, 'utf8'), 'one\ntwo\nthree')

  console.log(
    'PASS mixed/CR EOL status, guarded saves, explicit same-model normalization, and normalized writes'
  )

  const safeOpenPath = path.join(temporary, 'binary.dat')

  const safeOpenCopyPath = path.join(temporary, 'binary-copy.txt')

  const safeOpenBytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x10])

  await fs.writeFile(safeOpenPath, safeOpenBytes)

  const valueBeforeSafeOpen = await evaluate('editor.getValue()')

  const titleBeforeSafeOpen = await evaluate('document.title')

  openPath = safeOpenPath

  response = 1

  await click('Open...')

  assert.equal(await evaluate('editor.getValue()'), valueBeforeSafeOpen)

  assert.equal(await evaluate('document.title'), titleBeforeSafeOpen)

  assert.ok(messages.some((message) => message.title === 'Likely Binary File'))

  response = 0

  await click('Open...')

  await until(`document.title === 'binary.dat - Monaco Notepad'`, 'Safe Open binary document')

  assert.equal(
    await evaluate('editor.getOption(monaco.editor.EditorOption.readOnly)'),

    true
  )

  assert.match(
    await evaluate(`document.getElementById('statusbar').innerText`),

    /Safe Open/
  )

  const safeOpenWarningsBeforeReopen = messages.filter(
    (message) => message.title === 'Likely Binary File'
  ).length
  response = 0
  await clickSubmenu('Reopen With Encoding', 'UTF-8')
  await until(
    `editor.getOption(monaco.editor.EditorOption.readOnly) && /Safe Open/.test(document.getElementById('statusbar').innerText)`,
    'Safe Open explicit reopen protection'
  )
  assert.equal(
    messages.filter((message) => message.title === 'Likely Binary File').length,
    safeOpenWarningsBeforeReopen + 1
  )
  assert.equal(await evaluate(`document.title.startsWith('*')`), false)

  const originalBinaryBytes = await fs.readFile(safeOpenPath)

  await click('Save')

  assert.deepEqual(await fs.readFile(safeOpenPath), originalBinaryBytes)

  assert.match(
    await evaluate(`document.getElementById('transient-status').innerText`),

    /Safe Open/
  )

  const saveErrorsBeforeProtectedPath = messages.filter(
    (message) => message.title === 'Save Error'
  ).length

  savePath = safeOpenPath

  await click('Save As...')

  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      messages.filter((message) => message.title === 'Save Error').length >
      saveErrorsBeforeProtectedPath
    ) {
      break
    }

    await delay(50)
  }

  assert.equal(
    messages.filter((message) => message.title === 'Save Error').length,

    saveErrorsBeforeProtectedPath + 1
  )

  assert.deepEqual(await fs.readFile(safeOpenPath), originalBinaryBytes)

  assert.equal(
    await evaluate('editor.getOption(monaco.editor.EditorOption.readOnly)'),

    true
  )

  savePath = safeOpenCopyPath

  await click('Save As...')

  await until(
    `document.title === 'binary-copy.txt - Monaco Notepad'`,

    'Safe Open Save As copy'
  )

  assert.equal(
    await evaluate('editor.getOption(monaco.editor.EditorOption.readOnly)'),

    false
  )

  assert.equal(await evaluate(`document.getElementById('read-only').hidden`), true)

  assert.deepEqual(await fs.readFile(safeOpenPath), originalBinaryBytes)

  await setText('Safe Open copy is now editable')

  await click('Save')

  await until(`!document.title.startsWith('*')`, 'Safe Open copy normal save')

  assert.equal(
    await fs.readFile(safeOpenCopyPath, 'utf8'),

    'Safe Open copy is now editable'
  )

  assert.deepEqual(await fs.readFile(safeOpenPath), originalBinaryBytes)

  console.log(
    'PASS Safe Open cancel, forced read-only, protected original, Save As unlock, and normal save'
  )

  const filterFixture = 'Alpha alpha\nbeta alpha\nGamma\nalpha42 ALPHA'
  await setText(filterFixture)

  const filterLinesMenuItem = menuItem('Filter Lines...')
  assert.ok(filterLinesMenuItem, 'Menu: Filter Lines...')
  assert.equal(filterLinesMenuItem.accelerator, 'CmdOrCtrl+Shift+F')
  await click('Filter Lines...')
  await until(`!document.getElementById('line-filter').hidden`, 'Filter Lines menu command')
  assert.equal(await evaluate(`document.activeElement?.id`), 'line-filter-query')

  await setLineFilterControls({ query: 'alpha' })
  await until(
    `/5 matches on 3 lines/.test(document.getElementById('line-filter-summary').innerText)`,
    'literal line filter'
  )
  assert.equal(await evaluate(`document.querySelectorAll('.line-filter-result').length`), 3)

  await setLineFilterControls({
    query: 'alpha',
    caseSensitive: true
  })
  await until(
    `/3 matches on 3 lines/.test(document.getElementById('line-filter-summary').innerText)`,
    'case-sensitive line filter'
  )

  await setLineFilterControls({
    query: '^alpha',
    regex: true,
    caseSensitive: true
  })
  await until(
    `/1 match on 1 line/.test(document.getElementById('line-filter-summary').innerText)`,
    'regex line filter'
  )
  assert.equal(await evaluate(`document.querySelectorAll('.line-filter-result').length`), 1)

  await setLineFilterControls({
    query: '^alpha',
    regex: true,
    caseSensitive: true,
    invert: true
  })
  await until(
    `/3 non-matching lines/.test(document.getElementById('line-filter-summary').innerText)`,
    'inverted line filter'
  )
  assert.equal(await evaluate(`document.querySelectorAll('.line-filter-result').length`), 3)

  await setLineFilterControls({
    query: '[',
    regex: true
  })
  await until(
    `/Invalid regular expression/.test(document.getElementById('line-filter-summary').innerText)`,
    'invalid regex line filter'
  )
  assert.equal(await evaluate(`document.querySelectorAll('.line-filter-result').length`), 0)
  assert.equal(await evaluate(`editor.getValue()`), filterFixture)

  await setLineFilterControls({ query: 'Gamma' })
  await until(
    `document.querySelectorAll('.line-filter-result').length === 1`,
    'single filter navigation result'
  )
  await evaluate(`document.querySelector('.line-filter-result').click()`)
  assert.equal(await evaluate(`editor.getPosition().lineNumber`), 3)

  await setLineFilterControls({ query: 'alpha' })

  clipboard.writeText('')
  await evaluate(`document.getElementById('line-filter-copy-matching').click()`)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (clipboard.readText() === 'Alpha alpha\nbeta alpha\nalpha42 ALPHA') break
    await delay(50)
  }
  assert.equal(clipboard.readText(), 'Alpha alpha\nbeta alpha\nalpha42 ALPHA')

  clipboard.writeText('')
  await evaluate(`document.getElementById('line-filter-copy-nonmatching').click()`)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (clipboard.readText() === 'Gamma') break
    await delay(50)
  }
  assert.equal(clipboard.readText(), 'Gamma')

  assert.equal(await evaluate(`editor.getValue()`), filterFixture)

  await evaluate(`document.getElementById('line-filter-close').click()`)
  await until(`document.getElementById('line-filter').hidden`, 'Filter Lines close')

  console.log(
    'PASS Filter Lines literal, case, regex, invert, navigation, clipboard, and source preservation'
  )

  const extractionFixture = 'ID=12 id=7 nope'
  await setText(extractionFixture)
  await evaluate(`editor.setSelection(new monaco.Selection(1, 1, 1, 1))`)

  await click('Regex Extract...')
  await until(`!document.getElementById('regex-extract').hidden`, 'Regex Extract menu command')
  assert.equal(await evaluate(`document.activeElement?.id`), 'regex-extract-pattern')

  // Full-match extraction to the clipboard.
  await setRegexExtractControls({
    pattern: 'id=(\\d+)',
    caseSensitive: false,
    captureGroup: 0
  })
  await until(
    `/2 values from document/.test(document.getElementById('regex-extract-summary').innerText)`,
    'Regex Extract full-match summary'
  )

  clipboard.writeText('')
  await evaluate(`document.getElementById('regex-extract-copy').click()`)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (clipboard.readText() === 'ID=12\nid=7') break
    await delay(50)
  }
  assert.equal(clipboard.readText(), 'ID=12\nid=7')
  assert.equal(await evaluate(`editor.getValue()`), extractionFixture)

  // Capture-group extraction uses the requested group, not full matches.
  await setRegexExtractControls({
    pattern: 'id=(\\d+)',
    caseSensitive: false,
    captureGroup: 1
  })

  clipboard.writeText('')
  await evaluate(`document.getElementById('regex-extract-copy').click()`)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (clipboard.readText() === '12\n7') break
    await delay(50)
  }
  assert.equal(clipboard.readText(), '12\n7')
  assert.equal(await evaluate(`editor.getValue()`), extractionFixture)

  // Invalid regex must expose an error, disable destinations, and mutate nothing.
  await setRegexExtractControls({
    pattern: '[',
    captureGroup: 0
  })
  await until(
    `/Invalid regular expression/.test(document.getElementById('regex-extract-summary').innerText)`,
    'Regex Extract invalid regex'
  )
  assert.equal(await evaluate(`document.getElementById('regex-extract-copy').disabled`), true)
  assert.equal(await evaluate(`document.getElementById('regex-extract-replace').disabled`), true)
  assert.equal(await evaluate(`document.getElementById('regex-extract-untitled').disabled`), true)
  assert.equal(await evaluate(`editor.getValue()`), extractionFixture)

  // Two selected ranges must validate first, replace atomically, and undo in one step.
  const extractionAtomicFixture = 'A1 B2\nC3 D4'
  await setText(extractionAtomicFixture)
  await evaluate(`editor.setSelections([
    new monaco.Selection(1, 1, 1, 6),
    new monaco.Selection(2, 1, 2, 6)
  ])`)

  await setRegexExtractControls({
    pattern: '([A-Z])(\\d)',
    caseSensitive: true,
    captureGroup: 2
  })
  await until(
    `/4 values from 2 selections/.test(document.getElementById('regex-extract-summary').innerText)`,
    'Regex Extract multi-selection summary'
  )

  await evaluate(`document.getElementById('regex-extract-replace').click()`)
  await until(
    `editor.getValue() === ${JSON.stringify('1\n2\n3\n4')}`,
    'Regex Extract atomic replacement'
  )

  await click('Undo')
  await until(
    `editor.getValue() === ${JSON.stringify(extractionAtomicFixture)}`,
    'Regex Extract one-step undo'
  )

  // Open-as-Untitled must use the normal dirty-document lifecycle.
  response = 2
  await evaluate(`document.getElementById('regex-extract-untitled').click()`)
  await delay(250)

  assert.equal(await evaluate(`editor.getValue()`), extractionAtomicFixture)
  assert.equal(await evaluate(`document.getElementById('regex-extract').hidden`), false)
  assert.equal(await evaluate(`document.title.startsWith('*')`), true)

  response = 1
  await evaluate(`document.getElementById('regex-extract-untitled').click()`)
  await until(
    `editor.getValue() === ${JSON.stringify('1\n2\n3\n4')} &&
     document.title.includes('Untitled') &&
     document.title.startsWith('*') &&
     document.getElementById('regex-extract').hidden`,
    'Regex Extract guarded Open as Untitled'
  )

  // Leave a clean baseline for the existing Follow File runtime section.
  response = 1
  await click('New')
  await until(
    `editor.getValue() === '' &&
     document.title.includes('Untitled') &&
     !document.title.startsWith('*')`,
    'Regex Extract cleanup document'
  )

  console.log(
    'PASS Regex Extract full match, capture group, invalid-input safety, atomic replace/undo, clipboard, and guarded Untitled routing'
  )

  const typewriterFixture = Array.from(
    { length: 120 },
    (_, index) => `typewriter line ${index + 1}`
  ).join('\n')

  await setText(typewriterFixture)
  await click('Typewriter Scrolling')

  await evaluate(`editor.setPosition({ lineNumber: 80, column: 1 })`)
  await until(
    `(() => {
      const position = editor.getScrolledVisiblePosition({ lineNumber: 80, column: 1 })
      return position !== null &&
        Math.abs(
          position.top + position.height / 2 -
          editor.getLayoutInfo().height / 2
        ) < 80
    })()`,
    'Typewriter cursor centering'
  )

  // Manual scrolling must remain manual until the cursor itself moves.
  await evaluate(`editor.setScrollTop(0)`)
  await delay(250)
  assert.equal(await evaluate(`editor.getScrollTop()`), 0)

  // A restored file position must win over the cursor-change centering
  // triggered by setPosition during document restoration.
  const typewriterPositionPath = path.join(temporary, 'typewriter-position.txt')
  await fs.writeFile(
    typewriterPositionPath,
    Array.from({ length: 120 }, (_, index) => `stored line ${index + 1}`).join('\n')
  )

  await evaluate(`window.api.saveFilePosition(
    ${JSON.stringify(typewriterPositionPath)},
    {
      line: 80,
      column: 1,
      scrollTop: 0,
      accessedAt: Date.now()
    }
  )`)

  openPath = typewriterPositionPath
  response = 1
  await click('Open...')
  await until(
    `document.title === 'typewriter-position.txt - Monaco Notepad'`,
    'Typewriter stored-position fixture open'
  )
  await until(`editor.getPosition()?.lineNumber === 80`, 'Typewriter stored cursor restore')
  await delay(250)

  assert.equal(await evaluate(`editor.getScrollTop()`), 0)

  console.log(
    'PASS Typewriter Scrolling cursor centering, manual-scroll freedom, and stored-position precedence'
  )

  const followedPath = path.join(temporary, 'follow.log')
  await fs.writeFile(
    followedPath,
    Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n') + '\n'
  )
  openPath = followedPath
  response = 0
  await click('Open...')
  await until(`document.title === 'follow.log - Monaco Notepad'`, 'follow fixture open')
  await setText('dirty follow guard')
  response = 2
  await click('Follow File')
  await delay(200)
  assert.equal(await evaluate(`document.getElementById('follow-status').hidden`), true)
  assert.equal(await evaluate(`editor.getValue()`), 'dirty follow guard')
  response = 0
  await click('Reload from Disk')
  await until(`editor.getValue().startsWith('line 0\\n')`, 'follow dirty guard reset')
  await click('Read Only')
  await click('Follow File')
  await until(
    `/Following/.test(document.getElementById('follow-status').innerText) && editor.getOption(monaco.editor.EditorOption.readOnly)`,
    'follow mode entry'
  )
  await untilMenuItem(
    'Follow File',
    (item) => item.checked && item.enabled,
    'Follow File checked while active'
  )
  await untilMenuItem(
    'Read Only',
    (item) => item.checked && !item.enabled,
    'Follow lock reflected by Read Only'
  )

  for (const label of ['Save', 'Save As...', 'Reload from Disk', 'Revert to Saved']) {
    assert.equal(menuItem(label).enabled, false, `${label} disabled while following`)
  }

  const reopenWithEncoding = menuItem('Reopen With Encoding')
  assert.ok(reopenWithEncoding?.submenu)
  for (const item of reopenWithEncoding.submenu.items) {
    assert.equal(item.enabled, false, `${item.label} disabled while following`)
  }

  assert.equal(menuItem('Delete').enabled, false)
  assert.equal(menuItem('Base64 Encode').enabled, false)

  await click('Document Inspector...')
  await until(
    `document.getElementById('document-inspector-disk').innerText.includes('Exact size')`,
    'Follow inspector initial disk snapshot'
  )
  assert.equal(await inspectorValue('document-inspector-editor', 'Follow'), 'Active')
  assert.equal(await inspectorValue('document-inspector-editor', 'Access state'), 'Follow Lock')

  const followSnapshotSize = await inspectorValue('document-inspector-disk', 'Exact size')

  await fs.appendFile(followedPath, 'inspector refresh probe\n')
  await until(
    `editor.getValue().endsWith('inspector refresh probe\\n')`,
    'Follow inspector external append'
  )

  // The inspector is snapshot-based: Follow updates the editor, but the
  // disk section must remain unchanged until Refresh Disk is requested.
  await delay(350)
  assert.equal(await inspectorValue('document-inspector-disk', 'Exact size'), followSnapshotSize)

  const expectedRefreshedFollowSize = (await fs.stat(followedPath)).size
  await evaluate(`document.getElementById('document-inspector-refresh').click()`)

  await until(
    `Number((${inspectorValueExpression('document-inspector-disk', 'Exact size')}).replace(/[^0-9]/g, '')) === ${expectedRefreshedFollowSize}`,
    'Follow inspector manual disk refresh'
  )

  const refreshedFollowSize = await inspectorValue('document-inspector-disk', 'Exact size')
  assert.equal(Number(refreshedFollowSize.replace(/[^0-9]/g, '')), expectedRefreshedFollowSize)
  assert.equal(await inspectorValue('document-inspector-editor', 'Follow'), 'Active')

  await evaluate(`document.getElementById('document-inspector-close').click()`)
  await until(
    `document.getElementById('document-inspector-dialog').hidden && editor.hasTextFocus()`,
    'Follow inspector close focus restore'
  )
  console.log('PASS Document Inspector Follow manual refresh without polling')

  await click('Filter Lines...')
  await until(`!document.getElementById('line-filter').hidden`, 'Filter Lines during Follow')
  await setLineFilterControls({ query: 'needle' })
  await until(
    `/0 matches on 0 lines/.test(document.getElementById('line-filter-summary').innerText)`,
    'initial Follow filter state'
  )

  const fileChangeMessagesBeforeFollow = messages.filter((m) => m.title === 'File Changed').length
  await fs.appendFile(followedPath, 'followed 😀\n')
  await until(`editor.getValue().endsWith('followed 😀\\n')`, 'incremental followed append')

  await fs.appendFile(followedPath, 'nee')
  await until(
    `editor.getValue().endsWith('followed 😀\\nnee')`,
    'follow filter incomplete-line append'
  )
  assert.match(
    await evaluate(`document.getElementById('line-filter-summary').innerText`),
    /0 matches on 0 lines/
  )

  await fs.appendFile(followedPath, 'dle\n')
  await until(`editor.getValue().endsWith('needle\\n')`, 'follow filter incomplete-line completion')
  await until(
    `/1 match on 1 line/.test(document.getElementById('line-filter-summary').innerText)`,
    'incremental Follow filter match'
  )
  assert.equal(await evaluate(`document.querySelectorAll('.line-filter-result').length`), 1)

  // Match empty logical lines while completing one CRLF across two
  // independent Follow polls. A split CRLF must never surface a
  // phantom filtered empty line.
  await setLineFilterControls({
    query: '^$',
    regex: true,
    caseSensitive: true
  })
  await until(
    `/0 matches on 0 lines/.test(document.getElementById('line-filter-summary').innerText)`,
    'empty-line filter before split CRLF'
  )

  // Complete one CRLF across two independent Follow polling events.
  // The source accounting must merge CR + LF into one CRLF and Monaco
  // must retain exactly one line break.
  await fs.appendFile(followedPath, 'split boundary\r')
  await until(`editor.getValue().endsWith('split boundary\\n')`, 'follow trailing CR append')

  assert.equal(await evaluate(`document.getElementById('eol').value`), 'Mixed')
  assert.equal(await evaluate(`document.title.startsWith('*')`), false)
  assert.match(
    await evaluate(`document.getElementById('line-filter-summary').innerText`),
    /0 matches on 0 lines/
  )
  assert.equal(await evaluate(`document.querySelectorAll('.line-filter-result').length`), 0)

  const splitBoundaryLineCount = await evaluate(`editor.getModel().getLineCount()`)

  await fs.appendFile(followedPath, '\ncontinued')
  await until(
    `editor.getValue().endsWith('split boundary\\ncontinued')`,
    'follow split CRLF completion'
  )

  assert.equal(await evaluate(`editor.getModel().getLineCount()`), splitBoundaryLineCount)
  assert.equal(await evaluate(`document.getElementById('eol').value`), 'Mixed')
  assert.equal(await evaluate(`document.title.startsWith('*')`), false)
  assert.match(
    await evaluate(`document.getElementById('line-filter-summary').innerText`),
    /0 matches on 0 lines/
  )
  assert.equal(await evaluate(`document.querySelectorAll('.line-filter-result').length`), 0)

  await setLineFilterControls({ query: 'needle' })
  await until(
    `/1 match on 1 line/.test(document.getElementById('line-filter-summary').innerText)`,
    'restore Follow needle filter'
  )

  assert.equal(await evaluate(`document.title.startsWith('*')`), false)
  assert.equal(
    messages.filter((m) => m.title === 'File Changed').length,
    fileChangeMessagesBeforeFollow
  )
  await evaluate(`editor.setScrollTop(0)`)
  await until(
    `editor.getScrollTop() === 0 &&
      /paused/.test(document.getElementById('follow-status').innerText)`,
    'follow scroll pause'
  )
  const pausedScrollTop = await evaluate(`editor.getScrollTop()`)
  await fs.appendFile(followedPath, 'while paused\n')
  await until(`editor.getValue().endsWith('while paused\\n')`, 'append while scroll paused')
  await until(
    `/paused/.test(document.getElementById('follow-status').innerText)`,
    'follow remains paused after append'
  )
  const pausedScrollTopAfterAppend = await evaluate(`editor.getScrollTop()`)
  assert.ok(
    Math.abs(pausedScrollTopAfterAppend - pausedScrollTop) <= 2,
    `Follow paused scroll moved from ${pausedScrollTop} to ${pausedScrollTopAfterAppend}`
  )
  await evaluate(`editor.setScrollTop(editor.getScrollHeight())`)
  await until(
    `!/paused/.test(document.getElementById('follow-status').innerText)`,
    'follow scroll resume'
  )
  await fs.appendFile(followedPath, 'back at bottom\n')
  await until(`editor.getValue().endsWith('back at bottom\\n')`, 'append after scroll resume')
  const resetFollowText = 'needle reset line\n'

  await fs.writeFile(followedPath, resetFollowText)
  await until(
    `editor.getValue() === ${JSON.stringify('needle reset line\n')}`,
    'Follow truncation/reset content'
  )
  await until(
    `/1 match on 1 line/.test(document.getElementById('line-filter-summary').innerText)`,
    'Follow filter rebuild after reset'
  )
  assert.deepEqual(
    await evaluate(
      `[...document.querySelectorAll('.line-filter-line-text')].map((element) => element.textContent)`
    ),
    ['needle reset line']
  )
  assert.equal(await evaluate(`document.title.startsWith('*')`), false)

  await evaluate(`document.getElementById('line-filter-close').click()`)
  await until(`document.getElementById('line-filter').hidden`, 'close Follow line filter')

  console.log('PASS Filter Lines incremental Follow completion, split CRLF, and reset rebuild')

  await click('Follow File')
  await until(`document.getElementById('follow-status').hidden`, 'follow mode exit')
  await untilMenuItem(
    'Follow File',
    (item) => !item.checked && item.enabled,
    'Follow File restored after exit'
  )
  await untilMenuItem(
    'Read Only',
    (item) => item.checked && item.enabled,
    'prior voluntary Read Only restored after Follow'
  )

  for (const label of ['Save', 'Save As...', 'Reload from Disk', 'Revert to Saved']) {
    assert.equal(menuItem(label).enabled, true, `${label} restored after Follow`)
  }

  const restoredReopenWithEncoding = menuItem('Reopen With Encoding')
  assert.ok(restoredReopenWithEncoding?.submenu)
  for (const item of restoredReopenWithEncoding.submenu.items) {
    assert.equal(item.enabled, true, `${item.label} restored after Follow`)
  }

  assert.equal(
    await evaluate(`editor.getOption(monaco.editor.EditorOption.readOnly)`),
    true,
    'prior voluntary read-only state restored'
  )
  await click('Read Only')
  assert.equal(await evaluate(`editor.getOption(monaco.editor.EditorOption.readOnly)`), false)
  const followedValue = await evaluate(`editor.getValue()`)
  await click('Undo')
  assert.equal(await evaluate(`editor.getValue()`), followedValue)
  response = 2
  await fs.appendFile(followedPath, 'normal watcher restored\n')
  for (let attempt = 0; attempt < 40; attempt++) {
    if (messages.filter((m) => m.title === 'File Changed').length > fileChangeMessagesBeforeFollow)
      break
    await delay(50)
  }
  assert.ok(
    messages.filter((m) => m.title === 'File Changed').length > fileChangeMessagesBeforeFollow
  )
  console.log('PASS follow append, conflict suppression, scroll lock, clean state, and restore')

  const valueBeforeLargeFilePrompt = await evaluate('editor.getValue()')
  openPath = path.join(temporary, 'large.txt')
  const largeFileSize = 20 * 1024 * 1024
  const largeFileChunk = `${'x'.repeat(8191)}\n`
  assert.equal(Buffer.byteLength(largeFileChunk), 8192)
  assert.equal(largeFileSize % Buffer.byteLength(largeFileChunk), 0)
  const largeFileText = largeFileChunk.repeat(largeFileSize / Buffer.byteLength(largeFileChunk))
  assert.equal(Buffer.byteLength(largeFileText), largeFileSize)
  await fs.writeFile(openPath, largeFileText)
  response = 1
  await click('Open...')
  assert.equal(await evaluate('editor.getValue()'), valueBeforeLargeFilePrompt)
  assert.ok(messages.some((m) => /large/i.test(m.title || m.message)))
  response = 0
  await click('Open...')
  await until(
    `(() => {
      const detail = document.getElementById('open-progress-detail').innerText
      return /final step cannot be cancelled/i.test(detail) ||
        editor.getModel().getValueLength() === ${largeFileSize}
    })()`,
    'large file read completion',
    30000
  )
  await until(
    `editor.getModel().getValueLength() === ${largeFileSize}`,
    'large file opened in full',
    30000
  )
  assert.equal(await evaluate(`document.getElementById('open-progress-dialog').hidden`), true)
  assert.equal(
    await evaluate(`editor.getOption(monaco.editor.EditorOption.renderWhitespace)`),
    'none'
  )
  assert.equal(
    await evaluate(`editor.getOption(monaco.editor.EditorOption.renderControlCharacters)`),
    false
  )
  assert.equal(await evaluate(`document.getElementById('open-progress-bar').max`), 20 * 1024 * 1024)
  assert.equal(
    await evaluate(`document.getElementById('open-progress-bar').value`),
    20 * 1024 * 1024
  )
  assert.match(
    await evaluate(`document.getElementById('open-progress-detail').innerText`),
    /final step cannot be cancelled/i
  )
  await evaluate(`editor.setPosition({lineNumber: 1, column: 1})`)
  await click('Format JSON')
  assert.equal(await evaluate(`editor.getModel().getValueLength()`), 20 * 1024 * 1024)
  assert.match(
    await evaluate(`document.getElementById('transient-status').innerText`),
    /Large File Mode/
  )
  await click('Regex Extract...')
  await until(
    `!document.getElementById('regex-extract').hidden`,
    'Regex Extract Large File Mode open'
  )
  await until(
    `/Select text for Regex Extract in Large File Mode/.test(
      document.getElementById('regex-extract-summary').innerText
    )`,
    'Regex Extract Large File Mode whole-document guard'
  )
  assert.equal(await evaluate(`document.getElementById('regex-extract-copy').disabled`), true)
  assert.equal(await evaluate(`document.getElementById('regex-extract-replace').disabled`), true)
  assert.equal(await evaluate(`document.getElementById('regex-extract-untitled').disabled`), true)
  assert.equal(await evaluate(`editor.getModel().getValueLength()`), 20 * 1024 * 1024)
  await evaluate(`document.getElementById('regex-extract-close').click()`)
  await until(
    `document.getElementById('regex-extract').hidden`,
    'Regex Extract Large File Mode close'
  )

  console.log(
    'PASS large-file Cancel/Open, whole-document transform guard, and Regex Extract scan guard'
  )

  for (const width of [900, 400, 1400]) {
    window.setSize(width, 600)
    await delay(250)
    assert.equal(
      await evaluate(
        `document.getElementById('statusbar').scrollWidth <= document.getElementById('statusbar').clientWidth`
      ),
      true,
      `status overflow at ${width}`
    )
  }
  await click('Reopen Last Document')
  await click('50 MiB')
  const preferences = JSON.parse(
    await fs.readFile(path.join(temporary, 'profile', 'config.json'), 'utf8')
  )
  assert.equal(preferences.showWhitespace, true)
  assert.equal(preferences.showLineNumbers, false)
  assert.equal(preferences.statusBarVisible, true)
  assert.equal(preferences.typewriterScrolling, true)
  assert.equal(preferences.reopenLastDocument, true)
  assert.equal(preferences.backupOnSave, true)
  assert.equal(preferences.tabSize, 8)
  assert.equal(preferences.insertSpaces, false)
  assert.equal(preferences.autoIndent, 'full')
  assert.equal(preferences.trimTrailingWhitespaceOnSave, true)
  assert.equal(preferences.largeFileWarningMiB, 50)
  assert.equal(preferences.lastDocumentPath, openPath)
  console.log('PASS responsive status bar and persisted preferences')

  const settingsConfigPath = path.join(temporary, 'profile', 'config.json')
  const portableSettingsKeys = [
    'wordWrap',
    'typewriterScrolling',
    'zoomLevel',
    'statusBarVisible',
    'showWhitespace',
    'showLineNumbers',
    'reopenLastDocument',
    'backupOnSave',
    'trimTrailingWhitespaceOnSave',
    'autoIndent',
    'tabSize',
    'insertSpaces',
    'largeFileWarningMiB',
    'theme',
    'fontFamily',
    'fontSize',
    'defaultEncoding',
    'defaultEol',
    'primarySelectionPaste'
  ]
  const localSettingsKeys = [
    'lastDocumentPath',
    'lastDocumentEncoding',
    'windowWidth',
    'windowHeight',
    'lastDirectory',
    'recentFiles',
    'filePositions'
  ]

  const portabilityBefore = await evaluate(`window.api.preferences.getAll()`)
  const portabilityStoreBefore = JSON.parse(await fs.readFile(settingsConfigPath, 'utf8'))
  const localSettingsBefore = Object.fromEntries(
    localSettingsKeys.map((key) => [key, portabilityStoreBefore[key]])
  )
  const priorDialogSavePath = savePath
  const priorDialogOpenPath = openPath

  await evaluate(`window.api.openPreferencesDialog()`)
  preferencesWindow = undefined
  for (let attempt = 0; attempt < 120; attempt++) {
    preferencesWindow = BrowserWindow.getAllWindows().find((candidate) => candidate !== window)
    if (preferencesWindow && !preferencesWindow.webContents.isLoading()) break
    await delay(50)
  }
  assert.ok(preferencesWindow, 'Preferences window for settings portability')
  await untilIn(
    preferencesWindow,
    `!!document.getElementById('export-settings') && !!document.getElementById('import-settings')`,
    'settings portability controls'
  )

  const baselineExportPath = path.join(temporary, 'settings-baseline.json')
  savePath = baselineExportPath
  await evaluateIn(preferencesWindow, `document.getElementById('export-settings').click()`)
  await untilIn(
    preferencesWindow,
    `document.getElementById('settings-transfer-status').textContent === 'Settings exported.'`,
    'baseline settings export'
  )

  const baselineExport = JSON.parse(await fs.readFile(baselineExportPath, 'utf8'))
  assert.equal(baselineExport.format, 'monaco-notepad-settings')
  assert.equal(baselineExport.version, 1)
  assert.deepEqual(Object.keys(baselineExport.preferences).sort(), [...portableSettingsKeys].sort())
  assert.deepEqual(
    baselineExport.preferences,
    Object.fromEntries(portableSettingsKeys.map((key) => [key, portabilityBefore[key]]))
  )
  for (const key of localSettingsKeys) {
    assert.equal(
      Object.hasOwn(baselineExport.preferences, key),
      false,
      `${key} excluded from export`
    )
  }

  const importedSettings = {
    wordWrap: !portabilityBefore.wordWrap,
    typewriterScrolling: !portabilityBefore.typewriterScrolling,
    zoomLevel: portabilityBefore.zoomLevel === 3 ? 4 : 3,
    statusBarVisible: !portabilityBefore.statusBarVisible,
    showWhitespace: !portabilityBefore.showWhitespace,
    showLineNumbers: !portabilityBefore.showLineNumbers,
    reopenLastDocument: !portabilityBefore.reopenLastDocument,
    backupOnSave: !portabilityBefore.backupOnSave,
    trimTrailingWhitespaceOnSave: !portabilityBefore.trimTrailingWhitespaceOnSave,
    autoIndent: portabilityBefore.autoIndent === 'full' ? 'none' : 'full',
    tabSize: portabilityBefore.tabSize === 8 ? 4 : 8,
    insertSpaces: !portabilityBefore.insertSpaces,
    largeFileWarningMiB: portabilityBefore.largeFileWarningMiB === 50 ? 20 : 50,
    theme: portabilityBefore.theme === 'dark' ? 'light' : 'dark',
    fontFamily: portabilityBefore.fontFamily === 'Monospace' ? 'Courier New' : 'Monospace',
    fontSize: portabilityBefore.fontSize === 17 ? 18 : 17,
    defaultEncoding: portabilityBefore.defaultEncoding === 'utf16be' ? 'utf8' : 'utf16be',
    defaultEol: portabilityBefore.defaultEol === 'CRLF' ? 'LF' : 'CRLF',
    primarySelectionPaste: !portabilityBefore.primarySelectionPaste
  }

  for (const key of portableSettingsKeys) {
    assert.notDeepEqual(
      importedSettings[key],
      portabilityBefore[key],
      `${key} import fixture differs`
    )
  }

  const invalidImportPath = path.join(temporary, 'settings-invalid.json')
  await fs.writeFile(
    invalidImportPath,
    JSON.stringify(
      {
        format: 'monaco-notepad-settings',
        version: 1,
        preferences: { ...importedSettings, lastDocumentPath: '/must/not/import' }
      },
      null,
      2
    )
  )

  const invalidApiBefore = await evaluate(`window.api.preferences.getAll()`)
  const invalidStoreBefore = JSON.parse(await fs.readFile(settingsConfigPath, 'utf8'))
  const importErrorsBefore = messages.filter(
    (message) => message.title === 'Import Settings'
  ).length
  openPath = invalidImportPath
  await evaluateIn(preferencesWindow, `document.getElementById('import-settings').click()`)
  await untilIn(
    preferencesWindow,
    `document.getElementById('settings-transfer-status').textContent === 'Settings were not imported.'`,
    'invalid settings import rejection'
  )
  assert.equal(
    messages.filter((message) => message.title === 'Import Settings').length,
    importErrorsBefore + 1
  )
  assert.deepEqual(await evaluate(`window.api.preferences.getAll()`), invalidApiBefore)
  assert.deepEqual(JSON.parse(await fs.readFile(settingsConfigPath, 'utf8')), invalidStoreBefore)

  const validImportPath = path.join(temporary, 'settings-valid.json')
  await fs.writeFile(
    validImportPath,
    JSON.stringify(
      {
        format: 'monaco-notepad-settings',
        version: 1,
        preferences: importedSettings
      },
      null,
      2
    )
  )

  openPath = validImportPath
  await evaluateIn(preferencesWindow, `document.getElementById('import-settings').click()`)
  await untilIn(
    preferencesWindow,
    `document.getElementById('settings-transfer-status').textContent === 'Settings imported.'`,
    'valid settings import'
  )

  await until(
    `document.documentElement.dataset.theme === ${JSON.stringify(importedSettings.theme)} &&
      monaco.editor.EditorZoom.getZoomLevel() === ${importedSettings.zoomLevel}`,
    'imported theme and zoom'
  )

  const importedApi = await evaluate(`window.api.preferences.getAll()`)
  for (const key of portableSettingsKeys) {
    assert.deepEqual(importedApi[key], importedSettings[key], `${key} imported preference`)
  }

  const importedStore = JSON.parse(await fs.readFile(settingsConfigPath, 'utf8'))
  assert.deepEqual(
    Object.fromEntries(localSettingsKeys.map((key) => [key, importedStore[key]])),
    localSettingsBefore
  )

  assert.equal(nativeTheme.themeSource, importedSettings.theme)
  assert.equal(menuItem(importedSettings.theme === 'dark' ? 'Dark' : 'Light').checked, true)
  assert.equal(
    await evaluate(`editor.getOption(monaco.editor.EditorOption.wordWrap)`),
    importedSettings.wordWrap ? 'on' : 'off'
  )
  assert.equal(
    await evaluate(`editor.getOption(monaco.editor.EditorOption.renderWhitespace)`),
    importedSettings.showWhitespace ? 'all' : 'none'
  )
  assert.equal(
    await evaluate(`editor.getLayoutInfo().contentLeft > 20`),
    importedSettings.showLineNumbers
  )
  assert.equal(
    await evaluate(`document.getElementById('statusbar').style.display !== 'none'`),
    importedSettings.statusBarVisible
  )
  assert.equal(await evaluate(`editor.getRawOptions().fontSize`), importedSettings.fontSize)
  assert.equal(await evaluate(`editor.getModel().getOptions().tabSize`), importedSettings.tabSize)
  assert.equal(
    await evaluate(`editor.getModel().getOptions().insertSpaces`),
    importedSettings.insertSpaces
  )
  assert.equal(
    await evaluate(`editor.getOption(monaco.editor.EditorOption.autoIndent)`),
    importedSettings.autoIndent === 'full' ? 4 : 0
  )

  await untilIn(
    preferencesWindow,
    `(() => {
      const p = ${JSON.stringify(importedSettings)}
      const checkedValue = (name) =>
        [...document.querySelectorAll('input[name="' + name + '"]')].find((element) => element.checked)?.value
      return document.getElementById('font-family').value === p.fontFamily &&
        Number(document.getElementById('font-size').value) === p.fontSize &&
        checkedValue('tab-size') === String(p.tabSize) &&
        checkedValue('insert-spaces') === String(p.insertSpaces) &&
        checkedValue('auto-indent') === p.autoIndent &&
        document.getElementById('word-wrap').checked === p.wordWrap &&
        document.getElementById('trim-trailing-whitespace').checked === p.trimTrailingWhitespaceOnSave &&
        document.getElementById('show-whitespace').checked === p.showWhitespace &&
        document.getElementById('show-line-numbers').checked === p.showLineNumbers &&
        document.getElementById('primary-selection-paste').checked === p.primarySelectionPaste &&
        document.getElementById('reopen-last-document').checked === p.reopenLastDocument &&
        document.getElementById('backup-on-save').checked === p.backupOnSave &&
        document.getElementById('large-file-warning').value === String(p.largeFileWarningMiB) &&
        document.getElementById('default-encoding').value === p.defaultEncoding &&
        document.getElementById('default-eol').value === p.defaultEol &&
        document.getElementById('status-bar-visible').checked === p.statusBarVisible &&
        checkedValue('theme') === p.theme
    })()`,
    'Preferences controls refreshed after import'
  )

  const importedExportPath = path.join(temporary, 'settings-imported-roundtrip.json')
  savePath = importedExportPath
  await evaluateIn(preferencesWindow, `document.getElementById('export-settings').click()`)
  await untilIn(
    preferencesWindow,
    `document.getElementById('settings-transfer-status').textContent === 'Settings exported.'`,
    'imported settings export'
  )

  const importedExport = JSON.parse(await fs.readFile(importedExportPath, 'utf8'))
  assert.equal(importedExport.format, 'monaco-notepad-settings')
  assert.equal(importedExport.version, 1)
  assert.deepEqual(importedExport.preferences, importedSettings)
  for (const key of localSettingsKeys) {
    assert.equal(
      Object.hasOwn(importedExport.preferences, key),
      false,
      `${key} excluded after import`
    )
  }

  openPath = baselineExportPath
  await evaluateIn(preferencesWindow, `document.getElementById('import-settings').click()`)
  await until(
    `document.documentElement.dataset.theme === ${JSON.stringify(portabilityBefore.theme)} &&
      monaco.editor.EditorZoom.getZoomLevel() === ${portabilityBefore.zoomLevel}`,
    'baseline settings restore'
  )

  const restoredApi = await evaluate(`window.api.preferences.getAll()`)
  for (const key of portableSettingsKeys) {
    assert.deepEqual(
      restoredApi[key],
      portabilityBefore[key],
      `${key} restored after portability test`
    )
  }
  const restoredStore = JSON.parse(await fs.readFile(settingsConfigPath, 'utf8'))
  assert.deepEqual(
    Object.fromEntries(localSettingsKeys.map((key) => [key, restoredStore[key]])),
    localSettingsBefore
  )

  preferencesWindow.close()
  await delay(150)
  savePath = priorDialogSavePath
  openPath = priorDialogOpenPath

  console.log(
    'PASS settings export/import validation, live refresh, local-state preservation, and JSON round-trip'
  )

  await setText('newline state')
  assert.match(await evaluate(`document.getElementById('final-newline').innerText`), /No Final NL/)
  await click('Add Final Newline')
  assert.match(await evaluate(`document.getElementById('final-newline').innerText`), /^Final NL$/)
  await click('Remove Final Newline')
  assert.match(await evaluate(`document.getElementById('final-newline').innerText`), /No Final NL/)
  await click('Normalize to CRLF')
  assert.equal(await evaluate(`editor.getModel().getEOL()`), '\r\n')
  await click('Normalize to LF')
  assert.equal(await evaluate(`editor.getModel().getEOL()`), '\n')
  await click('Full Screen')
  await until(`document.getElementById('statusbar').style.display === 'none'`, 'fullscreen UI')
  await click('Full Screen')
  await until(`document.getElementById('statusbar').style.display !== 'none'`, 'fullscreen restore')
  console.log('PASS final newline, EOL normalization, status size, and fullscreen')

  window.setSize(900, 670)
  await setText('Visual check\n\tbookmark and whitespace\nselection contrast')
  await evaluate(`editor.setPosition({lineNumber: 2, column: 1})`)
  await click('Toggle Bookmark')
  await evaluate(`editor.setSelection(new monaco.Selection(3, 1, 3, 10))`)
  await delay(250)
  const screenshot = await window.webContents.capturePage()
  const screenshotPath = path.join(temporary, 'runtime.png')
  await fs.writeFile(screenshotPath, screenshot.toPNG())
  console.log(`Runtime screenshot: ${screenshotPath}`)
  console.log(`Runtime artifacts: ${temporary}`)
}

run()
  .then(async () => {
    await server.close()
    app.exit(0)
  })
  .catch(async (error) => {
    console.error(error)
    if (server) await server.close()
    app.exit(1)
  })
