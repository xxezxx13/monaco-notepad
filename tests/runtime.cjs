// Runs the actual sandboxed app with an isolated profile and temporary files.
// Native dialogs are answered deterministically; no personal documents are touched.
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
const { app, BrowserWindow, clipboard, dialog, Menu, shell } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

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

async function until(code, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(code)) return
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

  await setText('middle-click source')
  await evaluate(`editor.setSelection(new monaco.Selection(1, 1, 1, 7))`)
  await evaluate(`window.api.setPrimarySelection('paste')`)
  await evaluate(
    `document.getElementById('editor').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))`
  )
  await until(`editor.getValue() === 'paste-click source'`, 'primary-selection middle-click paste')
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
  console.log('PASS Document Inspector untitled state and focus restore')

  console.log('PASS Linux primary selection and middle-click paste')

  await setText('{"a":[1,true]}')
  await evaluate(`editor.setPosition({lineNumber: 1, column: 1})`)
  await click('Format JSON')
  assert.equal(
    await evaluate('editor.getValue()'),
    '{\n    "a": [\n        1,\n        true\n    ]\n}'
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
  await click('Base64 Encode')
  assert.equal(await evaluate('editor.getValue()'), 'abc')
  await click('SHA-256 (Copy)')
  assert.equal(
    clipboard.readText(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
  await click('Read Only')
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

  await evaluate(`editor.setSelection(new monaco.Selection(1, 1, 1, 6))`)
  await click('UPPERCASE')
  assert.equal(await evaluate(`editor.getModel().getLineContent(1)`), 'HELLO world')
  await click('Undo')
  assert.equal(await evaluate(`editor.getModel().getLineContent(1)`), 'hello world')
  await click('Title Case')
  assert.equal(await evaluate(`editor.getModel().getLineContent(1)`), 'Hello world')
  await click('lowercase')
  assert.equal(await evaluate(`editor.getModel().getLineContent(1)`), 'hello world')
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
  assert.equal(await evaluate('editor.getValue()'), 'beta  \n\talpha\t\n\nalpha')
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
  await click('Copy Full Path')
  assert.equal(clipboard.readText(), savePath)
  await click('Copy Filename')
  assert.equal(clipboard.readText(), path.basename(savePath))
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
  await click('SHA-256')
  assert.match(clipboard.readText(), /^[a-f0-9]{64}$/)
  const originalTitle = await evaluate('document.title')
  const copyPath = path.join(temporary, 'copy-only.txt')
  savePath = copyPath
  await click('Save a Copy...')
  assert.equal(await fs.readFile(copyPath, 'utf8'), await evaluate('editor.getValue()'))
  assert.equal(await evaluate('document.title'), originalTitle)
  savePath = path.join(temporary, 'saved.txt')
  await fs.writeFile(savePath, 'disk reload')
  response = 0
  await click('Reload from Disk')
  await until(`editor.getValue() === 'disk reload'`, 'explicit reload')
  await setText('dirty edits')
  await fs.writeFile(savePath, 'disk revert')
  response = 1
  await click('Revert to Saved')
  assert.equal(await evaluate('editor.getValue()'), 'dirty edits')
  response = 0
  await click('Revert to Saved')
  await until(`editor.getValue() === 'disk revert'`, 'confirmed revert')
  console.log('PASS file utilities, checksum, save copy, reload, and guarded revert')
  const fileChangeMessagesBeforeSelfSave = messages.filter((m) => m.title === 'File Changed').length
  await setText('saved again')
  await click('Save')
  await delay(400)
  assert.equal(await fs.readFile(savePath, 'utf8'), 'saved again')
  assert.equal(
    messages.filter((m) => m.title === 'File Changed').length,
    fileChangeMessagesBeforeSelfSave
  )
  const replacement = path.join(temporary, 'replacement.txt')
  await fs.writeFile(replacement, 'external replacement')
  response = 0
  await fs.rename(replacement, savePath)
  await until(`editor.getValue() === 'external replacement'`, 'atomic external reload')
  assert.equal(
    messages.filter((m) => m.title === 'File Changed').length,
    fileChangeMessagesBeforeSelfSave + 1
  )
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
  await evaluate(`document.getElementById('compare-keep').click()`)
  await until(`document.getElementById('compare-view').hidden`, 'close comparison')
  assert.equal(await evaluate('editor.getValue()'), 'current buffer')
  console.log('PASS compare against disk preserves current buffer and disposes diff view')
  response = 2
  await fs.chmod(savePath, 0o444)
  await delay(600)
  await evaluate(`window.dispatchEvent(new Event('focus'))`)
  await delay(200)
  assert.match(await evaluate(`document.getElementById('statusbar').innerText`), /Read Only/)
  await setText('read only edits')
  await click('Save')
  assert.equal(await fs.readFile(savePath, 'utf8'), 'disk comparison')
  assert.equal(await evaluate(`document.title.startsWith('*')`), true)
  assert.ok(messages.some((m) => m.title === 'Save Error'))
  savePath = path.join(temporary, 'writable-copy.txt')
  await click('Save As...')
  await until(`!document.title.startsWith('*')`, 'read-only save as')
  assert.equal(await fs.readFile(savePath, 'utf8'), 'read only edits')
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
    `/paused/.test(document.getElementById('follow-status').innerText)`,
    'follow scroll pause'
  )
  await fs.appendFile(followedPath, 'while paused\n')
  await until(`editor.getValue().endsWith('while paused\\n')`, 'append while scroll paused')
  assert.equal(await evaluate(`editor.getScrollTop()`), 0)
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
  await fs.writeFile(openPath, 'x'.repeat(20 * 1024 * 1024))
  response = 1
  await click('Open...')
  assert.equal(await evaluate('editor.getValue()'), valueBeforeLargeFilePrompt)
  assert.ok(messages.some((m) => /large/i.test(m.title || m.message)))
  response = 0
  await click('Open...')
  await until(
    `editor.getModel().getValueLength() === 20 * 1024 * 1024`,
    'large file opened in full'
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
  assert.equal(preferences.reopenLastDocument, true)
  assert.equal(preferences.tabSize, 8)
  assert.equal(preferences.insertSpaces, false)
  assert.equal(preferences.autoIndent, 'full')
  assert.equal(preferences.trimTrailingWhitespaceOnSave, true)
  assert.equal(preferences.largeFileWarningMiB, 50)
  assert.equal(preferences.lastDocumentPath, openPath)
  console.log('PASS responsive status bar and persisted preferences')

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
