/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const sourcePath = fileURLToPath(new URL('../src/renderer/src/line-filter.ts', import.meta.url))
const module = { exports: {} }

const compiled = ts.transpileModule(
  await import('node:fs/promises').then((fs) => fs.readFile(sourcePath, 'utf8')),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true
    }
  }
).outputText

vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  require,
  RegExp,
  Error
})

const { scanLineFilter } = module.exports
const plain = (value) => JSON.parse(JSON.stringify(value))

const options = (overrides = {}) => ({
  query: 'alpha',
  mode: 'literal',
  caseSensitive: false,
  invert: false,
  ...overrides
})

test('literal filtering counts occurrences separately from matching lines', () => {
  const result = plain(scanLineFilter('alpha alpha\nbeta\nALPHA\nomega', options()))

  assert.equal(result.error, null)
  assert.equal(result.active, true)
  assert.equal(result.matchCount, 3)
  assert.equal(result.matchingLineCount, 2)
  assert.equal(result.selectedLineCount, 2)
  assert.equal(result.sourceLineCount, 4)
  assert.deepEqual(
    result.lines.map(({ lineNumber, occurrences }) => ({
      lineNumber,
      occurrences
    })),
    [
      { lineNumber: 1, occurrences: 2 },
      { lineNumber: 3, occurrences: 1 }
    ]
  )
})

test('literal filtering honors case sensitivity', () => {
  const result = plain(scanLineFilter('alpha\nALPHA\nAlpha', options({ caseSensitive: true })))

  assert.equal(result.matchCount, 1)
  assert.equal(result.matchingLineCount, 1)
  assert.deepEqual(
    result.lines.map(({ lineNumber }) => lineNumber),
    [1]
  )
})

test('inverted filtering selects non-matching lines without losing positive counts', () => {
  const result = plain(scanLineFilter('alpha\nbeta\nALPHA\ngamma', options({ invert: true })))

  assert.equal(result.matchCount, 2)
  assert.equal(result.matchingLineCount, 2)
  assert.equal(result.selectedLineCount, 2)
  assert.deepEqual(
    result.lines.map(({ lineNumber, text, occurrences }) => ({
      lineNumber,
      text,
      occurrences
    })),
    [
      { lineNumber: 2, text: 'beta', occurrences: 0 },
      { lineNumber: 4, text: 'gamma', occurrences: 0 }
    ]
  )
})

test('regex filtering counts repeated matches on one line', () => {
  const result = plain(
    scanLineFilter(
      'item2 item10 item300\nnone\nITEM4',
      options({
        query: 'item\\d+',
        mode: 'regex'
      })
    )
  )

  assert.equal(result.error, null)
  assert.equal(result.matchCount, 4)
  assert.equal(result.matchingLineCount, 2)
  assert.equal(result.selectedLineCount, 2)
})

test('invalid regex reports an error and returns no partial results', () => {
  const result = plain(
    scanLineFilter(
      'alpha\nbeta',
      options({
        query: '[',
        mode: 'regex'
      })
    )
  )

  assert.equal(result.active, true)
  assert.equal(typeof result.error, 'string')
  assert.notEqual(result.error.length, 0)
  assert.equal(result.matchCount, 0)
  assert.equal(result.matchingLineCount, 0)
  assert.equal(result.selectedLineCount, 0)
  assert.equal(result.sourceLineCount, 0)
  assert.deepEqual(result.lines, [])
})

test('mixed CRLF LF and CR separators are each one logical line boundary', () => {
  const result = plain(
    scanLineFilter(
      'one\r\ntwo\nthree\rfour',
      options({
        query: '.+',
        mode: 'regex',
        caseSensitive: true
      })
    )
  )

  assert.equal(result.sourceLineCount, 4)
  assert.equal(result.matchCount, 4)
  assert.equal(result.matchingLineCount, 4)
  assert.deepEqual(
    result.lines.map(({ lineNumber, text }) => ({ lineNumber, text })),
    [
      { lineNumber: 1, text: 'one' },
      { lineNumber: 2, text: 'two' },
      { lineNumber: 3, text: 'three' },
      { lineNumber: 4, text: 'four' }
    ]
  )
})

test('unterminated final line is scanned and trailing EOL adds no phantom line', () => {
  const unterminated = plain(
    scanLineFilter(
      'one\ntwo',
      options({
        query: '.+',
        mode: 'regex',
        caseSensitive: true
      })
    )
  )

  const terminated = plain(
    scanLineFilter(
      'one\ntwo\n',
      options({
        query: '.+',
        mode: 'regex',
        caseSensitive: true
      })
    )
  )

  assert.equal(unterminated.sourceLineCount, 2)
  assert.equal(terminated.sourceLineCount, 2)
  assert.equal(unterminated.selectedLineCount, 2)
  assert.equal(terminated.selectedLineCount, 2)
})

test('zero-length regex matches terminate deterministically', () => {
  const result = plain(
    scanLineFilter(
      'abc',
      options({
        query: '^|$',
        mode: 'regex',
        caseSensitive: true
      })
    )
  )

  assert.equal(result.matchCount, 2)
  assert.equal(result.matchingLineCount, 1)
  assert.equal(result.selectedLineCount, 1)
})

test('empty query is inactive rather than matching every line', () => {
  const result = plain(
    scanLineFilter(
      'alpha\nbeta',
      options({
        query: ''
      })
    )
  )

  assert.equal(result.active, false)
  assert.equal(result.error, null)
  assert.equal(result.matchCount, 0)
  assert.equal(result.selectedLineCount, 0)
  assert.deepEqual(result.lines, [])
})

test('incremental tail replacement extends an incomplete final line', () => {
  const filterOptions = options({
    query: 'error',
    caseSensitive: true
  })

  const initial = plain(scanLineFilter('alpha\nerr', filterOptions))
  const updated = plain(
    module.exports.replaceLineFilterTail(initial, 'err', 'error\nbeta', 2, filterOptions)
  )

  assert.equal(updated.matchCount, 1)
  assert.equal(updated.matchingLineCount, 1)
  assert.equal(updated.sourceLineCount, 3)
  assert.equal(updated.selectedLineCount, 1)
  assert.deepEqual(updated.lines, [
    {
      lineNumber: 2,
      text: 'error',
      occurrences: 1
    }
  ])
})

test('incremental tail replacement turns a trailing phantom line into real content', () => {
  const filterOptions = options({
    query: 'error',
    caseSensitive: true
  })

  const initial = plain(scanLineFilter('alpha\n', filterOptions))
  const updated = plain(
    module.exports.replaceLineFilterTail(initial, '', 'error\n', 2, filterOptions)
  )

  assert.equal(updated.matchCount, 1)
  assert.equal(updated.matchingLineCount, 1)
  assert.equal(updated.sourceLineCount, 2)
  assert.equal(updated.selectedLineCount, 1)
  assert.equal(updated.lines[0].lineNumber, 2)
  assert.equal(updated.lines[0].text, 'error')
})

test('incremental inverted filtering removes a tail line when it becomes matching', () => {
  const filterOptions = options({
    query: 'hit',
    caseSensitive: true,
    invert: true
  })

  const initial = plain(scanLineFilter('hit\nmiss', filterOptions))
  const updated = plain(
    module.exports.replaceLineFilterTail(initial, 'miss', 'miss hit', 2, filterOptions)
  )

  assert.equal(updated.matchCount, 2)
  assert.equal(updated.matchingLineCount, 2)
  assert.equal(updated.sourceLineCount, 2)
  assert.equal(updated.selectedLineCount, 0)
  assert.deepEqual(updated.lines, [])
})
