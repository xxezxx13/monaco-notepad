import type { Preferences } from './preferences'

export const portableSettingsFormat = 'monaco-notepad-settings' as const
export const portableSettingsVersion = 1 as const

export type PortablePreferenceKey =
  | 'wordWrap'
  | 'typewriterScrolling'
  | 'zoomLevel'
  | 'statusBarVisible'
  | 'showWhitespace'
  | 'showLineNumbers'
  | 'reopenLastDocument'
  | 'backupOnSave'
  | 'trimTrailingWhitespaceOnSave'
  | 'autoIndent'
  | 'tabSize'
  | 'insertSpaces'
  | 'largeFileWarningMiB'
  | 'theme'
  | 'fontFamily'
  | 'fontSize'
  | 'defaultEncoding'
  | 'defaultEol'
  | 'primarySelectionPaste'

export type PortablePreferences = Pick<Preferences, PortablePreferenceKey>

export interface PortableSettingsFile {
  format: typeof portableSettingsFormat
  version: typeof portableSettingsVersion
  preferences: PortablePreferences
}

export const portablePreferenceKeys = [
  'wordWrap',
  'typewriterScrolling',
  'zoomLevel',
  'statusBarVisible',
  'showWhitespace',
  'showLineNumbers',
  'reopenLastDocument',
  'backupOnSave',
  'trimTrailingWhitespaceOnSave',
  'autoIndent',
  'tabSize',
  'insertSpaces',
  'largeFileWarningMiB',
  'theme',
  'fontFamily',
  'fontSize',
  'defaultEncoding',
  'defaultEol',
  'primarySelectionPaste'
] as const satisfies readonly PortablePreferenceKey[]

const topLevelKeys = ['format', 'version', 'preferences'] as const

function invalid(detail: string): never {
  throw new Error(`Invalid portable settings: ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function expectExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()

  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} keys`)
  }
}

function expectBoolean(value: Record<string, unknown>, key: string): boolean {
  const candidate = value[key]
  if (typeof candidate !== 'boolean') invalid(key)
  return candidate
}

function expectString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string') invalid(key)
  return candidate
}

function expectNumber(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  integer = false
): number {
  const candidate = value[key]
  if (
    typeof candidate !== 'number' ||
    !Number.isFinite(candidate) ||
    candidate < minimum ||
    candidate > maximum ||
    (integer && !Number.isInteger(candidate))
  ) {
    invalid(key)
  }
  return candidate
}

function expectOneOf<T extends string | number>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const candidate = value[key]
  if (!allowed.some((item) => item === candidate)) invalid(key)
  return candidate as T
}

export function validatePortableSettings(value: unknown): PortableSettingsFile {
  if (!isRecord(value)) invalid('root')
  expectExactKeys(value, topLevelKeys, 'top-level')

  if (value.format !== portableSettingsFormat) invalid('format')
  if (value.version !== portableSettingsVersion) invalid('version')
  if (!isRecord(value.preferences)) invalid('preferences')

  const raw = value.preferences
  expectExactKeys(raw, portablePreferenceKeys, 'preference')

  const preferences: PortablePreferences = {
    wordWrap: expectBoolean(raw, 'wordWrap'),
    typewriterScrolling: expectBoolean(raw, 'typewriterScrolling'),
    zoomLevel: expectNumber(raw, 'zoomLevel', -5, 20, true),
    statusBarVisible: expectBoolean(raw, 'statusBarVisible'),
    showWhitespace: expectBoolean(raw, 'showWhitespace'),
    showLineNumbers: expectBoolean(raw, 'showLineNumbers'),
    reopenLastDocument: expectBoolean(raw, 'reopenLastDocument'),
    backupOnSave: expectBoolean(raw, 'backupOnSave'),
    trimTrailingWhitespaceOnSave: expectBoolean(raw, 'trimTrailingWhitespaceOnSave'),
    autoIndent: expectOneOf(raw, 'autoIndent', ['none', 'full'] as const),
    tabSize: expectOneOf(raw, 'tabSize', [2, 4, 8] as const),
    insertSpaces: expectBoolean(raw, 'insertSpaces'),
    largeFileWarningMiB: expectOneOf(raw, 'largeFileWarningMiB', [10, 20, 50, 100] as const),
    theme: expectOneOf(raw, 'theme', ['system', 'light', 'dark'] as const),
    fontFamily: expectString(raw, 'fontFamily'),
    fontSize: expectNumber(raw, 'fontSize', 8, 72),
    defaultEncoding: expectOneOf(raw, 'defaultEncoding', [
      'utf8',
      'utf8-bom',
      'utf16le',
      'utf16be',
      'windows1252'
    ] as const),
    defaultEol: expectOneOf(raw, 'defaultEol', ['LF', 'CRLF'] as const),
    primarySelectionPaste: expectBoolean(raw, 'primarySelectionPaste')
  }

  return {
    format: portableSettingsFormat,
    version: portableSettingsVersion,
    preferences
  }
}

export function parsePortableSettingsJson(text: string): PortableSettingsFile {
  return validatePortableSettings(JSON.parse(text))
}

export function createPortableSettingsFile(source: Preferences): PortableSettingsFile {
  const preferences = Object.fromEntries(
    portablePreferenceKeys.map((key) => [key, source[key]])
  ) as PortablePreferences

  return validatePortableSettings({
    format: portableSettingsFormat,
    version: portableSettingsVersion,
    preferences
  })
}
