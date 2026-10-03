import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = fs.readFileSync('src/main/settings-portability.ts', 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText

const module = { exports: {} }
vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  require(name) {
    throw new Error(`Unexpected runtime dependency: ${name}`)
  }
})

const {
  createPortableSettingsFile,
  parsePortableSettingsJson,
  portablePreferenceKeys,
  portableSettingsFormat,
  portableSettingsVersion,
  validatePortableSettings
} = module.exports

const portable = {
  wordWrap: true,
  typewriterScrolling: true,
  zoomLevel: 3,
  statusBarVisible: true,
  showWhitespace: true,
  showLineNumbers: true,
  reopenLastDocument: true,
  backupOnSave: true,
  trimTrailingWhitespaceOnSave: true,
  autoIndent: 'full',
  tabSize: 8,
  insertSpaces: false,
  largeFileWarningMiB: 50,
  theme: 'dark',
  fontFamily: 'Monospace',
  fontSize: 17,
  defaultEncoding: 'utf16be',
  defaultEol: 'CRLF',
  primarySelectionPaste: false
}

const local = {
  lastDocumentPath: '/tmp/local.txt',
  lastDocumentEncoding: 'windows1252',
  windowWidth: 1111,
  windowHeight: 777,
  lastDirectory: '/tmp',
  recentFiles: ['/tmp/local.txt'],
  filePositions: {
    '/tmp/local.txt': { line: 4, column: 2, scrollTop: 12, accessedAt: 123 }
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JavaScript test helper
function document(overrides = {}) {
  return {
    format: portableSettingsFormat,
    version: portableSettingsVersion,
    preferences: { ...portable },
    ...overrides
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JavaScript test helper
function withPreference(key, value) {
  return document({ preferences: { ...portable, [key]: value } })
}

test('exports exactly the portable preference whitelist', () => {
  const exported = createPortableSettingsFile({ ...portable, ...local })

  assert.equal(exported.format, 'monaco-notepad-settings')
  assert.equal(exported.version, 1)
  assert.deepEqual(Object.keys(exported.preferences).sort(), [...portablePreferenceKeys].sort())
  assert.equal(Object.keys(exported.preferences).length, 19)

  for (const key of Object.keys(local)) {
    assert.equal(Object.hasOwn(exported.preferences, key), false, `${key} must remain local`)
  }
})

test('parses a complete version 1 portable settings document', () => {
  const parsed = parsePortableSettingsJson(JSON.stringify(document()))
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.preferences)), portable)
})

test('rejects malformed JSON and invalid root metadata', () => {
  assert.throws(() => parsePortableSettingsJson('{'))
  assert.throws(() => validatePortableSettings(null), /Invalid portable settings/)
  assert.throws(
    () => validatePortableSettings({ ...document(), format: 'other-settings' }),
    /Invalid portable settings: format/
  )
  assert.throws(
    () => validatePortableSettings({ ...document(), version: 2 }),
    /Invalid portable settings: version/
  )
  assert.throws(
    () => validatePortableSettings({ ...document(), extra: true }),
    /Invalid portable settings: top-level keys/
  )
})

test('rejects missing and unknown preference keys', () => {
  const missing = { ...portable }
  delete missing.wordWrap

  assert.throws(
    () => validatePortableSettings(document({ preferences: missing })),
    /Invalid portable settings: preference keys/
  )
  assert.throws(
    () =>
      validatePortableSettings(
        document({ preferences: { ...portable, lastDocumentPath: '/must/not/import' } })
      ),
    /Invalid portable settings: preference keys/
  )
})

test('rejects invalid booleans, enums, numbers, and strings', () => {
  const invalidCases = [
    ['wordWrap', 'true'],
    ['typewriterScrolling', 1],
    ['zoomLevel', -6],
    ['zoomLevel', 21],
    ['zoomLevel', 1.5],
    ['zoomLevel', Number.NaN],
    ['statusBarVisible', null],
    ['showWhitespace', 'yes'],
    ['showLineNumbers', 0],
    ['reopenLastDocument', 'false'],
    ['backupOnSave', 1],
    ['trimTrailingWhitespaceOnSave', 'true'],
    ['autoIndent', 'advanced'],
    ['tabSize', 3],
    ['insertSpaces', 'false'],
    ['largeFileWarningMiB', 25],
    ['theme', 'graphite'],
    ['fontFamily', 123],
    ['fontSize', 7],
    ['fontSize', 73],
    ['fontSize', '17'],
    ['fontSize', Number.POSITIVE_INFINITY],
    ['defaultEncoding', 'auto'],
    ['defaultEol', 'CR'],
    ['primarySelectionPaste', 'false']
  ]

  for (const [key, value] of invalidCases) {
    assert.throws(
      () => validatePortableSettings(withPreference(key, value)),
      /Invalid portable settings/,
      `${key}=${String(value)}`
    )
  }
})

test('accepts documented numeric boundary values', () => {
  for (const zoomLevel of [-5, 20]) {
    assert.equal(
      validatePortableSettings(withPreference('zoomLevel', zoomLevel)).preferences.zoomLevel,
      zoomLevel
    )
  }

  for (const fontSize of [8, 72]) {
    assert.equal(
      validatePortableSettings(withPreference('fontSize', fontSize)).preferences.fontSize,
      fontSize
    )
  }
})
