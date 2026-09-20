import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const sourcePath = fileURLToPath(new URL('../src/renderer/src/text.ts', import.meta.url))
const module = { exports: {} }
const compiled = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText
vm.runInNewContext(compiled, { module, exports: module.exports })
const {
  countCharacters,
  countWords,
  convertCase,
  deleteEmptyLines,
  formatFileSize,
  indentationSpacesToTabs,
  removeDuplicateLines,
  sortLines,
  tabsToSpaces,
  trimTrailingWhitespace
} = module.exports

test('character counts use Unicode code points and include actual line endings', () => {
  assert.equal(countCharacters('A😀 B\nC'), 6)
  assert.equal(countCharacters('A\r\nB'), 4)
})

test('text cleanup and deterministic line operations', () => {
  assert.equal(trimTrailingWhitespace('one  \n two\t\r\nthree'), 'one\n two\r\nthree')
  assert.equal(sortLines('beta\nAlpha\ngamma'), 'Alpha\nbeta\ngamma')
  assert.equal(sortLines('beta\nAlpha\ngamma', true), 'gamma\nbeta\nAlpha')
  assert.equal(removeDuplicateLines('one\ntwo\none\nOne'), 'one\ntwo\nOne')
  assert.equal(deleteEmptyLines('one\n \n\t\ntwo'), 'one\ntwo')
})

test('tab conversion respects tab stops and only tabifies indentation', () => {
  assert.equal(tabsToSpaces('\titem\n  \tnext\na\tb', 4), '    item\n    next\na    b')
  assert.equal(
    indentationSpacesToTabs('        one\n      two\na    b', 4),
    '\t\tone\n\t  two\na    b'
  )
})

test('file sizes use compact binary units', () => {
  assert.equal(formatFileSize(842), '842 B')
  assert.equal(formatFileSize(18842), '18.4 KB')
  assert.equal(formatFileSize(3.7 * 1024 * 1024), '3.7 MB')
})

test('word counts use predictable non-whitespace runs', () => {
  assert.equal(countWords('  one\ttwo\r\nthree 😀  '), 4)
  assert.equal(countWords(' \n\t '), 0)
})

test('case conversion is deterministic and Unicode aware', () => {
  assert.equal(convertCase('Café déjà VU', 'upper'), 'CAFÉ DÉJÀ VU')
  assert.equal(convertCase('Café déjà VU', 'lower'), 'café déjà vu')
  assert.equal(convertCase("hELLO o'NEILL ÉLAN", 'title'), "Hello O'neill Élan")
})
