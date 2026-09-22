// Isolated startup-order regression: explicit file > recovery > optional last file.
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mode = process.argv[2]
let server

async function evaluate(window, code) {
  return window.webContents.executeJavaScript(code, true)
}

async function until(window, code, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(window, code)) return
    await delay(50)
  }
  throw new Error(`Timed out: ${description}`)
}

async function run() {
  assert.ok(
    ['explicit', 'recovery', 'scratchpad', 'last', 'missing'].includes(mode),
    `Unknown mode: ${mode}`
  )
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'monaco-notepad-startup-'))
  const profile = path.join(temporary, 'profile')
  await fs.mkdir(profile, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('sessionData', path.join(temporary, 'session'))

  const explicitPath = path.join(temporary, 'explicit.txt')
  const lastPath = path.join(temporary, 'last.txt')
  await fs.writeFile(explicitPath, 'explicit document')
  await fs.writeFile(lastPath, 'last document')
  await fs.writeFile(
    path.join(profile, 'config.json'),
    JSON.stringify({
      reopenLastDocument: true,
      showWhitespace: mode === 'last',
      showLineNumbers: mode !== 'last',
      lastDocumentPath: mode === 'missing' ? path.join(temporary, 'missing.txt') : lastPath,
      lastDocumentEncoding: 'auto'
    })
  )
  if (mode === 'explicit' || mode === 'recovery' || mode === 'scratchpad') {
    await fs.writeFile(
      path.join(profile, 'recovery.json'),
      JSON.stringify({
        filePath: mode === 'recovery' ? lastPath : null,
        text: mode === 'scratchpad' ? 'persistent scratchpad' : 'recovered document',
        encoding: 'utf8',
        eol: 'LF',
        ...(mode === 'recovery'
          ? {
              sourceEol: {
                kind: 'Mixed',
                counts: { crlf: 1, lf: 1, cr: 1 }
              },
              eolNormalizationTarget: null
            }
          : {}),
        ...(mode === 'scratchpad'
          ? { position: { line: 1, column: 4, scrollTop: 0, languageOverride: 'markdown' } }
          : {})
      })
    )
  }

  const messages = []
  dialog.showMessageBox = async (_window, options) => {
    messages.push(options)
    return { response: 0, checkboxChecked: false }
  }

  const { createServer } = await import('vite')
  server = await createServer({
    configFile: false,
    root: path.resolve('src/renderer'),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error'
  })
  await server.listen()
  process.env.ELECTRON_RENDERER_URL = server.resolvedUrls.local[0]
  process.argv = [process.execPath, __filename, ...(mode === 'explicit' ? [explicitPath] : [])]
  require('../out/main/index.js')
  await app.whenReady()

  let window
  for (let attempt = 0; attempt < 120; attempt++) {
    window = BrowserWindow.getAllWindows()[0]
    if (window && !window.webContents.isLoading()) break
    await delay(50)
  }
  await until(
    window,
    `!!window.api && performance.getEntriesByType('resource').some(e => /monaco-editor.*editor.*api/.test(e.name))`,
    'editor module'
  )
  await evaluate(
    window,
    `(async () => {
      const url = performance.getEntriesByType('resource').find(e => /monaco-editor.*editor.*api/.test(e.name)).name;
      window.monaco = await import(url);
      window.editor = monaco.editor.getEditors()[0];
    })()`
  )

  const expected =
    mode === 'explicit'
      ? 'explicit document'
      : mode === 'recovery'
        ? 'recovered document'
        : mode === 'scratchpad'
          ? 'persistent scratchpad'
          : mode === 'last'
            ? 'last document'
            : ''
  await until(
    window,
    `window.editor?.getValue() === ${JSON.stringify(expected)}`,
    `${mode} startup`
  )
  if (mode === 'recovery') {
    assert.equal(await evaluate(window, `document.getElementById('eol').value`), 'Mixed')
  }

  if (mode === 'explicit') {
    assert.equal(
      messages.some((message) => message.title === 'Recover Document'),
      false
    )
  }
  if (mode === 'missing') {
    const preferences = JSON.parse(await fs.readFile(path.join(profile, 'config.json'), 'utf8'))
    assert.equal(preferences.lastDocumentPath, null)
  }
  if (mode === 'last') {
    const whitespace = await evaluate(
      window,
      `window.editor.getOption(window.monaco.editor.EditorOption.renderWhitespace)`
    )
    assert.equal(whitespace, 'all')
    assert.equal(await evaluate(window, `window.editor.getLayoutInfo().contentLeft`), 10)
  }
  if (mode === 'scratchpad') {
    assert.equal(await evaluate(window, `window.editor.getPosition().column`), 4)
    assert.equal(await evaluate(window, `window.editor.getModel().getLanguageId()`), 'markdown')
  }
  console.log(`PASS startup priority: ${mode}`)
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
