// Exercises responsive large-file loading through the real sandboxed renderer.
// Native dialogs are answered deterministically; no personal files are touched.
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog, Menu } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const originalOpen = fs.open.bind(fs)
let delayedReadPath
let delayedReadCount = 0
let delayedCloseCount = 0

fs.open = async (...args) => {
  const handle = await originalOpen(...args)
  if (args[0] !== delayedReadPath) return handle

  return new Proxy(handle, {
    get(target, property) {
      if (property === 'read') {
        return async (...readArgs) => {
          delayedReadCount++
          await delay(15)
          return target.read(...readArgs)
        }
      }

      if (property === 'close') {
        return async () => {
          delayedCloseCount++
          return target.close()
        }
      }

      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

let openPath
let server
let temporary
let window

dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [openPath] })
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

function menuItem(label, menu = Menu.getApplicationMenu()) {
  for (const item of menu.items) {
    if (item.label === label) return item
    const nested = item.submenu && menuItem(label, item.submenu)
    if (nested) return nested
  }
}

async function openFromMenu() {
  const item = menuItem('Open...')
  assert.ok(item, 'Open menu item')
  item.click(item, window)
}

async function run() {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'monaco-notepad-large-runtime-'))
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
  openPath = path.join(temporary, 'large.txt')
  await fs.writeFile(openPath, 'x'.repeat(20 * 1024 * 1024))

  await openFromMenu()
  await until(
    `!document.getElementById('open-progress-dialog').hidden &&
      !document.getElementById('open-progress-cancel').disabled`,
    'large-file read progress'
  )
  await evaluate(`document.getElementById('open-progress-cancel').click()`)
  await until(`document.getElementById('open-progress-dialog').hidden`, 'large-file cancellation')
  assert.equal(await evaluate(`editor.getValue()`), '')
  assert.equal(await evaluate(`document.title`), 'Untitled - Monaco Notepad')

  await openFromMenu()
  await until(
    `editor.getModel().getValueLength() === 20 * 1024 * 1024`,
    'large file opened in full'
  )
  assert.equal(await evaluate(`document.getElementById('open-progress-dialog').hidden`), true)
  assert.equal(await evaluate(`document.getElementById('open-progress-bar').max`), 20 * 1024 * 1024)
  assert.equal(
    await evaluate(`document.getElementById('open-progress-bar').value`),
    20 * 1024 * 1024
  )
  assert.match(
    await evaluate(`document.getElementById('open-progress-detail').innerText`),
    /final step cannot be cancelled/i
  )

  delayedReadPath = path.join(temporary, 'destroy-owner.txt')
  await fs.writeFile(delayedReadPath, Buffer.alloc(24 * 1024 * 1024, 0x79))
  openPath = delayedReadPath
  delayedReadCount = 0
  delayedCloseCount = 0

  await openFromMenu()
  await until(
    `!document.getElementById('open-progress-dialog').hidden &&
      !document.getElementById('open-progress-cancel').disabled`,
    'owner-destruction read progress'
  )

  assert.ok(delayedReadCount > 0)
  const readsAtDestroy = delayedReadCount

  // Keep this test process alive after destroying its only BrowserWindow so
  // request-owner destruction can be observed from the main process.
  app.removeAllListeners('window-all-closed')
  window.destroy()

  for (let attempt = 0; attempt < 100 && delayedCloseCount === 0; attempt++) {
    await delay(5)
  }

  assert.equal(delayedCloseCount, 1)
  assert.ok(delayedReadCount <= readsAtDestroy + 1)

  const readsAfterClose = delayedReadCount
  await delay(100)
  assert.equal(delayedReadCount, readsAfterClose)

  console.log(
    'PASS responsive large-file progress, cancellation, full model commit, and owner-destruction abort'
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
