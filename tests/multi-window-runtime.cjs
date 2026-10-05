// Exercises simultaneous document windows through the real sandboxed renderer.
// Native dialogs are answered deterministically; no personal files are touched.
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let openPath
let server
let temporary
let window

let dialogResponse = 0

dialog.showMessageBox = async () => ({ response: dialogResponse, checkboxChecked: false })
dialog.showOpenDialog = async () => ({
  canceled: false,
  filePaths: [openPath]
})
dialog.showSaveDialog = async () => ({ canceled: true })

async function evaluate(code) {
  return window.webContents.executeJavaScript(code, true)
}

async function until(code, description) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await evaluate(code)) return
    await delay(5)
  }
  throw new Error(`Timed out: ${description}`)
}

async function run() {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'monaco-notepad-multi-window-runtime-'))
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
  const ownerWindow = window
  const { Menu } = require('electron')

  const evaluateIn = (targetWindow, code) => targetWindow.webContents.executeJavaScript(code, true)

  const untilIn = async (targetWindow, code, description, timeoutMs = 8000) => {
    const attempts = Math.ceil(timeoutMs / 50)
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await evaluateIn(targetWindow, code)) return
      await delay(50)
    }
    throw new Error('Timed out: ' + description)
  }

  const initializeDocumentWindow = async (targetWindow, title, text) => {
    await untilIn(
      targetWindow,
      '!!window.api && performance.getEntriesByType("resource").some((entry) => /monaco-editor.*editor.*api/.test(entry.name))',
      title + ' Monaco module'
    )

    await evaluateIn(
      targetWindow,
      '(async () => { const url = performance.getEntriesByType("resource").find((entry) => /monaco-editor.*editor.*api/.test(entry.name)).name; window.monaco = await import(url); window.editor = monaco.editor.getEditors()[0] })()'
    )

    await untilIn(targetWindow, '!!window.editor', title + ' editor startup')
    await untilIn(
      targetWindow,
      'document.title === ' +
        JSON.stringify(title) +
        ' && editor.getValue() === ' +
        JSON.stringify(text),
      title + ' document load'
    )
  }

  const openDocumentWindow = async (filePath, title, text) => {
    const existingIds = new Set(BrowserWindow.getAllWindows().map((candidate) => candidate.id))

    await evaluateIn(
      ownerWindow,
      'window.api.openFilePathInNewWindow(' + JSON.stringify(filePath) + ')'
    )

    let openedWindow
    for (let attempt = 0; attempt < 160; attempt++) {
      openedWindow = BrowserWindow.getAllWindows().find(
        (candidate) => !existingIds.has(candidate.id)
      )
      if (openedWindow && !openedWindow.webContents.isLoading()) break
      await delay(25)
    }

    assert.ok(openedWindow, title + ' BrowserWindow')
    await initializeDocumentWindow(openedWindow, title, text)
    return openedWindow
  }

  const menuItem = (label, menu = Menu.getApplicationMenu()) => {
    for (const item of menu.items) {
      if (item.label === label) return item
      const nested = item.submenu && menuItem(label, item.submenu)
      if (nested) return nested
    }
  }

  const saveFocusedDocument = async (targetWindow, filePath, expectedText) => {
    const saveItem = menuItem('Save')
    assert.ok(saveItem, 'Save menu item')
    assert.equal(saveItem.enabled, true)

    const originalGetFocusedWindow = BrowserWindow.getFocusedWindow

    try {
      BrowserWindow.getFocusedWindow = () => targetWindow
      assert.equal(BrowserWindow.getFocusedWindow(), targetWindow)
      saveItem.click(saveItem, targetWindow)
    } finally {
      BrowserWindow.getFocusedWindow = originalGetFocusedWindow
    }

    assert.equal(BrowserWindow.getFocusedWindow, originalGetFocusedWindow)
    await delay(150)

    for (let attempt = 0; attempt < 120; attempt++) {
      if ((await fs.readFile(filePath, 'utf8')) === expectedText) return
      await delay(50)
    }

    throw new Error('Timed out: focused Save for ' + path.basename(filePath))
  }

  const fileA = path.join(temporary, 'multi-window-a.txt')
  const fileB = path.join(temporary, 'multi-window-b.txt')
  const initialA = 'document A initial'
  const initialB = 'document B initial'

  await fs.writeFile(fileA, initialA, 'utf8')
  await fs.writeFile(fileB, initialB, 'utf8')

  assert.equal(await evaluateIn(ownerWindow, 'window.api.isSessionOwner()'), true)

  const windowA = await openDocumentWindow(fileA, 'multi-window-a.txt - Monaco Notepad', initialA)

  const windowB = await openDocumentWindow(fileB, 'multi-window-b.txt - Monaco Notepad', initialB)

  assert.notEqual(windowA.id, windowB.id)
  assert.notEqual(windowA.id, ownerWindow.id)
  assert.notEqual(windowB.id, ownerWindow.id)
  assert.equal(await evaluateIn(windowA, 'window.api.isSessionOwner()'), false)
  assert.equal(await evaluateIn(windowB, 'window.api.isSessionOwner()'), false)
  assert.equal(windowA.isDestroyed(), false)
  assert.equal(windowB.isDestroyed(), false)
  assert.equal(ownerWindow.isDestroyed(), false)

  let savedA = 'document A saved independently'
  await evaluateIn(windowA, 'editor.setValue(' + JSON.stringify(savedA) + ')')
  await untilIn(windowA, 'document.title.startsWith("*")', 'document A dirty')

  await saveFocusedDocument(windowA, fileA, savedA)
  await untilIn(windowA, '!document.title.startsWith("*")', 'document A clean after Save')

  assert.equal(await fs.readFile(fileB, 'utf8'), initialB)
  assert.equal(await evaluateIn(windowB, 'editor.getValue()'), initialB)
  assert.equal(await evaluateIn(windowB, 'document.title'), 'multi-window-b.txt - Monaco Notepad')

  let savedB = 'document B saved independently'
  await evaluateIn(windowB, 'editor.setValue(' + JSON.stringify(savedB) + ')')
  await untilIn(windowB, 'document.title.startsWith("*")', 'document B dirty')

  await saveFocusedDocument(windowB, fileB, savedB)
  await untilIn(windowB, '!document.title.startsWith("*")', 'document B clean after Save')

  assert.equal(await fs.readFile(fileA, 'utf8'), savedA)
  assert.equal(await evaluateIn(windowA, 'editor.getValue()'), savedA)

  const clickFocusedMenu = async (targetWindow, label) => {
    const item = menuItem(label)
    assert.ok(item, 'Menu: ' + label)

    const originalGetFocusedWindow = BrowserWindow.getFocusedWindow

    try {
      BrowserWindow.getFocusedWindow = () => targetWindow
      assert.equal(BrowserWindow.getFocusedWindow(), targetWindow)
      item.click(item, targetWindow)
    } finally {
      BrowserWindow.getFocusedWindow = originalGetFocusedWindow
    }

    assert.equal(BrowserWindow.getFocusedWindow, originalGetFocusedWindow)
    await delay(150)
  }

  const externalA = 'document A externally replaced'
  const replacementA = path.join(temporary, 'multi-window-a-replacement.txt')
  await fs.writeFile(replacementA, externalA, 'utf8')
  await fs.rename(replacementA, fileA)

  await untilIn(
    windowA,
    'editor.getValue() === ' + JSON.stringify(externalA),
    'document A isolated external reload',
    10000
  )

  savedA = externalA
  assert.equal(await fs.readFile(fileA, 'utf8'), savedA)
  assert.equal(await evaluateIn(windowB, 'editor.getValue()'), savedB)
  assert.equal(await fs.readFile(fileB, 'utf8'), savedB)
  assert.equal(await evaluateIn(windowB, 'document.title'), 'multi-window-b.txt - Monaco Notepad')

  await clickFocusedMenu(windowB, 'Follow File')

  await untilIn(
    windowB,
    '/Following/.test(document.getElementById("follow-status").innerText) && document.getElementById("follow-status").hidden === false && editor.getOption(monaco.editor.EditorOption.readOnly)',
    'document B isolated Follow start',
    10000
  )

  assert.equal(await evaluateIn(windowA, 'document.getElementById("follow-status").hidden'), true)
  assert.equal(
    await evaluateIn(windowA, 'editor.getOption(monaco.editor.EditorOption.readOnly)'),
    false
  )

  const followAppend = '\nfollow B append\n'
  const followedB = savedB + followAppend
  await fs.appendFile(fileB, followAppend, 'utf8')

  await untilIn(
    windowB,
    'editor.getValue() === ' + JSON.stringify(followedB),
    'document B isolated Follow append',
    10000
  )

  savedB = followedB
  assert.equal(await evaluateIn(windowA, 'editor.getValue()'), savedA)
  assert.equal(await fs.readFile(fileA, 'utf8'), savedA)

  await clickFocusedMenu(windowB, 'Follow File')

  await untilIn(
    windowB,
    'document.getElementById("follow-status").hidden',
    'document B isolated Follow stop',
    10000
  )

  assert.equal(await evaluateIn(windowA, 'document.getElementById("follow-status").hidden'), true)

  console.log('PASS per-window watcher and Follow isolation')

  const windowCountBeforePreferences = BrowserWindow.getAllWindows().length
  await evaluateIn(windowB, 'window.api.openPreferencesDialog()')

  let preferencesWindow
  for (let attempt = 0; attempt < 120; attempt++) {
    preferencesWindow = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes('preferences')
    )
    if (preferencesWindow && !preferencesWindow.webContents.isLoading()) break
    await delay(50)
  }

  assert.ok(preferencesWindow, 'Preferences window')
  assert.equal(BrowserWindow.getAllWindows().length, windowCountBeforePreferences + 1)
  assert.notEqual(preferencesWindow.id, ownerWindow.id)
  assert.notEqual(preferencesWindow.id, windowA.id)
  assert.notEqual(preferencesWindow.id, windowB.id)

  preferencesWindow.close()
  for (let attempt = 0; attempt < 80; attempt++) {
    if (preferencesWindow.isDestroyed()) break
    await delay(25)
  }
  assert.equal(preferencesWindow.isDestroyed(), true)
  assert.equal(windowA.isDestroyed(), false)
  assert.equal(windowB.isDestroyed(), false)

  windowA.close()
  for (let attempt = 0; attempt < 120; attempt++) {
    if (windowA.isDestroyed()) break
    await delay(50)
  }

  assert.equal(windowA.isDestroyed(), true)
  assert.equal(windowB.isDestroyed(), false)
  assert.equal(ownerWindow.isDestroyed(), false)
  assert.equal(await evaluateIn(windowB, 'editor.getValue()'), savedB)
  assert.equal(await evaluateIn(windowB, 'window.api.isSessionOwner()'), false)
  assert.equal(await evaluateIn(ownerWindow, 'window.api.isSessionOwner()'), true)

  const afterCloseB = 'document B remains functional after A closes'
  await evaluateIn(windowB, 'editor.setValue(' + JSON.stringify(afterCloseB) + ')')
  dialogResponse = 1
  await saveFocusedDocument(windowB, fileB, afterCloseB)
  dialogResponse = 0
  assert.equal(await fs.readFile(fileA, 'utf8'), savedA)

  console.log(
    'PASS simultaneous document windows, session ownership, focused Save isolation, Preferences separation, and independent close'
  )
}

run()
  .then(async () => {
    await server.close()
    await fs.rm(temporary, { recursive: true, force: true })
    app.exit(0)
  })
  .catch(async (error) => {
    console.error(error)
    if (server) await server.close()
    if (temporary) await fs.rm(temporary, { recursive: true, force: true })
    app.exit(1)
  })
