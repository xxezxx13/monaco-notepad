import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const sourcePath = fileURLToPath(new URL('../src/renderer/src/transforms.ts', import.meta.url))
const module = { exports: {} }
const compiled = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText
vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  btoa,
  atob
})

const {
  formatJson,
  minifyJson,
  formatXml,
  encodeBase64,
  decodeBase64,
  encodeUrl,
  decodeUrl,
  encodeHex,
  decodeHex,
  normalizeUnicode
} = module.exports

test('JSON formatting and minification preserve values and indentation', () => {
  assert.equal(formatJson('{"a":[1,true]}', 2), '{\n  "a": [\n    1,\n    true\n  ]\n}')
  assert.equal(formatJson('[1,{"a":2}]', '\t'), '[\n\t1,\n\t{\n\t\t"a": 2\n\t}\n]')
  assert.equal(minifyJson(' { "a": [1, 2] } '), '{"a":[1,2]}')
  assert.throws(() => formatJson('{bad}', 2), /JSON|property|token/i)
})

test('XML formatting is conservative for text and mixed content', () => {
  assert.equal(
    formatXml('<root xmlns:x="urn:x"><x:item a="1"><child/></x:item></root>', '  '),
    '<root xmlns:x="urn:x">\n  <x:item a="1">\n    <child/>\n  </x:item>\n</root>'
  )
  assert.equal(formatXml('<p>Hello <b>world</b>!</p>', '  '), '<p>Hello <b>world</b>!</p>')
  assert.equal(
    formatXml('<root><value>  keep me  </value></root>', '  '),
    '<root>\n  <value>  keep me  </value>\n</root>'
  )
  assert.throws(() => formatXml('<root><bad></root>', '  '), /Invalid XML/)
  assert.throws(
    () => formatXml('<!DOCTYPE root SYSTEM "https://example.test/x"><root/>', '  '),
    /DTD/
  )
})

test('Base64 transforms are Unicode-safe and strict', () => {
  for (const value of ['hello', 'Café', '😀'])
    assert.equal(decodeBase64(encodeBase64(value)), value)
  assert.throws(() => decodeBase64('%%%='), /Invalid Base64/)
  assert.throws(() => decodeBase64('/w=='), /valid UTF-8/)
})

test('URL transforms use component semantics and reject malformed escapes', () => {
  const input = 'a b/c?x=✓'
  assert.equal(encodeUrl(input), 'a%20b%2Fc%3Fx%3D%E2%9C%93')
  assert.equal(decodeUrl(encodeUrl(input)), input)
  assert.throws(() => decodeUrl('%E0%A4%A'), /Invalid URL encoding/)
})

test('hex transforms use lowercase UTF-8 and reject invalid bytes', () => {
  assert.equal(encodeHex('Hello'), '48656c6c6f')
  assert.equal(decodeHex(encodeHex('Café 😀')), 'Café 😀')
  assert.throws(() => decodeHex('abc'), /Invalid hexadecimal/)
  assert.throws(() => decodeHex('gg'), /Invalid hexadecimal/)
  assert.throws(() => decodeHex('ff'), /valid UTF-8/)
})

test('Unicode normalization is explicit across all supported forms', () => {
  assert.equal(normalizeUnicode('e\u0301', 'NFC'), '\u00e9')
  assert.equal(normalizeUnicode('\u00e9', 'NFD'), 'e\u0301')
  assert.equal(normalizeUnicode('\uff21', 'NFKC'), 'A')
  assert.equal(normalizeUnicode('\uff21', 'NFKD'), 'A')
})
