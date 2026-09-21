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
  console.log('PASS Linux primary selection and middle-click paste')

  await setText('{"a":[1,true]}')
  await evaluate(`editor.setPosition({lineNumber: 1, column: 1})`)
  await click('Format JSON')
  assert.equal(
    await evaluate('editor.getValue()'),
    '{\n    "a": [\n        1,\n        true\n    ]\n}'
  )
  await click('Undo')
  assert.equal(await evaluate('editor.getValue()'), '{"a":[1,true]}')
  await setText('one two')
  await evaluate(
    `editor.setSelections([new monaco.Selection(1,1,1,4), new monaco.Selection(1,5,1,8)])`
  )
  await click('Base64 Encode')
  assert.equal(await evaluate('editor.getValue()'), 'b25l dHdv')
  await click('Undo')
  assert.equal(await evaluate('editor.getValue()'), 'one two')
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
  await click('Undo')
  assert.equal(await evaluate('editor.getValue()'), 'prefix {"a":1} suffix')
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
  await click('File Properties')
  assert.ok(messages.some((m) => m.title === 'File Properties' && m.detail.includes(savePath)))
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
  const fileChangeMessagesBeforeFollow = messages.filter((m) => m.title === 'File Changed').length
  await fs.appendFile(followedPath, 'followed 😀\n')
  await until(`editor.getValue().endsWith('followed 😀\\n')`, 'incremental followed append')
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
  console.log('PASS large-file Cancel/Open without truncation and whole-document transform guard')

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
