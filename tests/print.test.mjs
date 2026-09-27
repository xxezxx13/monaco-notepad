import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8'
)

const start = source.indexOf("'file:print'")
const end = source.indexOf("'file:get-size'", start)

assert.notEqual(start, -1, 'file:print handler must exist')
assert.notEqual(end, -1, 'file:print handler boundary must exist')

const printHandler = source.slice(start, end)

test('Print preflights configured printers instead of silently failing', () => {
  assert.match(printHandler, /getPrintersAsync\(\)/)
  assert.match(printHandler, /printers\.length === 0/)
  assert.match(printHandler, /No printers are configured\./)
  assert.match(printHandler, /CUPS printer destinations/)
})

test('Print captures and reports Electron print failures', () => {
  assert.match(
    printHandler,
    /\(success,\s*failureReason\)\s*=>/
  )

  assert.match(
    printHandler,
    /resolvePrint\(\{\s*success,\s*failureReason\s*\}\)/
  )

  assert.match(
    printHandler,
    /failureReason !== 'Print job canceled'/
  )

  assert.match(
    printHandler,
    /The document could not be printed\./
  )
})

test('Print preserves the hardened temporary BrowserWindow baseline', () => {
  assert.match(printHandler, /contextIsolation:\s*true/)
  assert.match(printHandler, /nodeIntegration:\s*false/)
  assert.match(printHandler, /sandbox:\s*true/)
})
