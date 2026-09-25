import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const sourcePath = fileURLToPath(new URL('../src/renderer/src/extraction.ts', import.meta.url))
const module = { exports: {} }

const compiled = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText

vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  RegExp,
  Error,
  Number
})

const { extractRegex } = module.exports

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function hostResult(result) {
  return {
    values: Array.from(result.values),
    matchCount: result.matchCount,
    text: result.text
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function hostValues(result) {
  return Array.from(result.values)
}

test('regex extraction supports full matches and capture groups', () => {
  assert.deepEqual(
    hostResult(
      extractRegex('ID=12 id=7 nope', {
        pattern: 'id=(\\d+)',
        caseSensitive: false,
        captureGroup: 0
      })
    ),
    {
      values: ['ID=12', 'id=7'],
      matchCount: 2,
      text: 'ID=12\nid=7'
    }
  )

  assert.deepEqual(
    hostResult(
      extractRegex(
        'ID=12 id=7 nope',
        {
          pattern: 'id=(\\d+)',
          caseSensitive: false,
          captureGroup: 1
        },
        '\r\n'
      )
    ),
    {
      values: ['12', '7'],
      matchCount: 2,
      text: '12\r\n7'
    }
  )
})

test('regex extraction honors case sensitivity', () => {
  assert.deepEqual(
    hostValues(
      extractRegex('ID=12 id=7', {
        pattern: 'id=(\\d+)',
        caseSensitive: true,
        captureGroup: 1
      })
    ),
    ['7']
  )
})

test('regex extraction rejects invalid input before producing a result', () => {
  assert.throws(
    () =>
      extractRegex('abc', {
        pattern: '[',
        caseSensitive: false,
        captureGroup: 0
      }),
    /Invalid regular expression/
  )

  assert.throws(
    () =>
      extractRegex('abc', {
        pattern: '(abc)',
        caseSensitive: false,
        captureGroup: 2
      }),
    /Capture group 2 does not exist/
  )

  assert.throws(
    () =>
      extractRegex('abc', {
        pattern: '(abc)',
        caseSensitive: false,
        captureGroup: -1
      }),
    /non-negative integer/
  )

  assert.throws(
    () =>
      extractRegex('abc', {
        pattern: '',
        caseSensitive: false,
        captureGroup: 0
      }),
    /Enter a regular expression/
  )
})

test('optional and zero-length captures terminate deterministically', () => {
  assert.deepEqual(
    hostValues(
      extractRegex('a ab', {
        pattern: 'a(b)?',
        caseSensitive: true,
        captureGroup: 1
      })
    ),
    ['', 'b']
  )

  const zeroLength = extractRegex('ab', {
    pattern: '^|$',
    caseSensitive: true,
    captureGroup: 0
  })

  assert.equal(zeroLength.matchCount, 2)
  assert.deepEqual(hostValues(zeroLength), ['', ''])
})

test('no matches return a valid empty extraction', () => {
  assert.deepEqual(
    hostResult(
      extractRegex('abc', {
        pattern: '\\d+',
        caseSensitive: true,
        captureGroup: 0
      })
    ),
    {
      values: [],
      matchCount: 0,
      text: ''
    }
  )
})
