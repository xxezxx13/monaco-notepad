import * as monaco from 'monaco-editor/editor/editor.api'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import 'monaco-editor/features/bracketMatching/register'
import 'monaco-editor/features/caretOperations/register'
import 'monaco-editor/features/clipboard/register'
import 'monaco-editor/features/codeEditor/register'
import 'monaco-editor/features/comment/register'
import 'monaco-editor/features/contextmenu/register'
import 'monaco-editor/features/find/register'
import 'monaco-editor/features/fontZoom/register'
import 'monaco-editor/features/gotoLine/register'
import 'monaco-editor/features/indentation/register'
import 'monaco-editor/features/linesOperations/register'
import 'monaco-editor/features/multicursor/register'
import 'monaco-editor/features/tokenization/register'
import 'monaco-editor/features/wordOperations/register'
import 'monaco-editor/features/wordPartOperations/register'
import 'monaco-editor/languages/definitions/css/register'
import 'monaco-editor/languages/definitions/bat/register'
import 'monaco-editor/languages/definitions/cpp/register'
import 'monaco-editor/languages/definitions/csharp/register'
import 'monaco-editor/languages/definitions/dockerfile/register'
import 'monaco-editor/languages/definitions/go/register'
import 'monaco-editor/languages/definitions/graphql/register'
import 'monaco-editor/languages/definitions/html/register'
import 'monaco-editor/languages/definitions/ini/register'
import 'monaco-editor/languages/definitions/java/register'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/languages/definitions/kotlin/register'
import 'monaco-editor/languages/definitions/less/register'
import 'monaco-editor/languages/definitions/lua/register'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/languages/definitions/perl/register'
import 'monaco-editor/languages/definitions/php/register'
import 'monaco-editor/languages/definitions/powershell/register'
import 'monaco-editor/languages/definitions/python/register'
import 'monaco-editor/languages/definitions/r/register'
import 'monaco-editor/languages/definitions/ruby/register'
import 'monaco-editor/languages/definitions/rust/register'
import 'monaco-editor/languages/definitions/scss/register'
import 'monaco-editor/languages/definitions/shell/register'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/swift/register'
import 'monaco-editor/languages/definitions/typescript/register'
import 'monaco-editor/languages/definitions/vb/register'
import 'monaco-editor/languages/definitions/xml/register'
import 'monaco-editor/languages/definitions/yaml/register'
import { createDocumentState, isDocumentDirty } from './document'
import {
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
} from './text'
import {
  decodeBase64,
  decodeHex,
  decodeUrl,
  encodeBase64,
  encodeHex,
  encodeUrl,
  formatJson,
  formatXml,
  minifyJson,
  type TextTransform
} from './transforms'

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker()
  }
}

// Monaco ships JSON tokenization with its full language service. This small
// Monarch definition keeps highlighting without bundling that worker.
monaco.languages.register({ id: 'json' })
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
      [/"(?:[^"\\]|\\.)*"/, 'string.value.json'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number.json'],
      [/\b(?:true|false|null)\b/, 'keyword.json'],
      [/[{}[\]]/, 'delimiter.bracket.json'],
      [/[,:]/, 'delimiter.json'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment']
    ],
    comment: [
      [/[^*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/\*/, 'comment']
    ]
  }
})

monaco.editor.defineTheme('monaco-notepad-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'DCE5F2' },
    { token: 'comment', foreground: '6F8197', fontStyle: 'italic' },
    { token: 'keyword', foreground: '62AEEF' },
    { token: 'keyword.control', foreground: '62AEEF' },
    { token: 'type', foreground: '71C4C5' },
    { token: 'type.identifier', foreground: '71C4C5' },
    { token: 'identifier', foreground: 'DCE5F2' },
    { token: 'string', foreground: 'DDB96A' },
    { token: 'string.key.json', foreground: '8FC7F4' },
    { token: 'number', foreground: 'B7A5E5' },
    { token: 'regexp', foreground: 'D98C8C' },
    { token: 'operator', foreground: '9DB0C7' },
    { token: 'delimiter', foreground: '8FA0B5' },
    { token: 'tag', foreground: '62AEEF' },
    { token: 'attribute.name', foreground: '8FC7F4' },
    { token: 'attribute.value', foreground: 'DDB96A' },
    { token: 'metatag', foreground: '7F91A7' },
    { token: 'variable', foreground: 'DCE5F2' },
    { token: 'constant', foreground: 'B7A5E5' }
  ],
  colors: {
    'editor.background': '#0C121B',
    'editor.foreground': '#DCE5F2',
    'editorCursor.foreground': '#65B5FF',
    'editor.selectionBackground': '#174F7F',
    'editor.inactiveSelectionBackground': '#173853',
    'editor.selectionHighlightBackground': '#1C4462',
    'editor.wordHighlightBackground': '#1C446266',
    'editor.wordHighlightStrongBackground': '#27577777',
    'editor.findMatchBackground': '#946D20',
    'editor.findMatchHighlightBackground': '#5F4B2266',
    'editor.findRangeHighlightBackground': '#2588E81F',
    'editor.lineHighlightBackground': '#131D2A',
    'editorLineNumber.foreground': '#53667E',
    'editorLineNumber.activeForeground': '#A6B6C9',
    'editorWhitespace.foreground': '#263447',
    'editorIndentGuide.background1': '#1D2938',
    'editorIndentGuide.activeBackground1': '#344961',
    'editorWidget.background': '#182231',
    'editorWidget.foreground': '#DCE5F2',
    'editorWidget.border': '#34445A',
    'input.background': '#101824',
    'input.foreground': '#DCE5F2',
    'input.border': '#34445A',
    'input.placeholderForeground': '#73849A',
    focusBorder: '#2588E8',
    'list.activeSelectionBackground': '#1768AE',
    'list.activeSelectionForeground': '#FFFFFF',
    'list.hoverBackground': '#223044',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#53667E55',
    'scrollbarSlider.hoverBackground': '#657B956F',
    'scrollbarSlider.activeBackground': '#7B93AF88'
  }
})

monaco.editor.defineTheme('monaco-notepad-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '000000' },
    { token: 'comment', foreground: '008000', fontStyle: 'italic' },
    { token: 'keyword', foreground: '0000FF' },
    { token: 'keyword.control', foreground: '0000FF' },
    { token: 'type', foreground: '267F99' },
    { token: 'type.identifier', foreground: '267F99' },
    { token: 'identifier', foreground: '000000' },
    { token: 'string', foreground: 'A31515' },
    { token: 'string.key.json', foreground: 'A31515' },
    { token: 'number', foreground: '098658' },
    { token: 'regexp', foreground: '811F3F' },
    { token: 'operator', foreground: '000000' },
    { token: 'delimiter', foreground: '000000' },
    { token: 'tag', foreground: '800000' },
    { token: 'attribute.name', foreground: 'FF0000' },
    { token: 'attribute.value', foreground: '0000FF' },
    { token: 'metatag', foreground: '800080' },
    { token: 'variable', foreground: '000000' },
    { token: 'constant', foreground: '098658' }
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#000000',
    'editorCursor.foreground': '#000000',
    'editor.selectionBackground': '#ADD6FF',
    'editor.inactiveSelectionBackground': '#E5E5E5',
    'editor.selectionHighlightBackground': '#ADD6FF66',
    'editor.wordHighlightBackground': '#D6EBFF',
    'editor.wordHighlightStrongBackground': '#A8D1FF',
    'editor.findMatchBackground': '#FFCC00',
    'editor.findMatchHighlightBackground': '#FFEC9966',
    'editor.findRangeHighlightBackground': '#0066CC1F',
    'editor.lineHighlightBackground': '#F5F5F5',
    'editorLineNumber.foreground': '#808080',
    'editorLineNumber.activeForeground': '#000000',
    'editorWhitespace.foreground': '#D0D0D0',
    'editorIndentGuide.background1': '#E5E5E5',
    'editorIndentGuide.activeBackground1': '#C8C8C8',
    'editorWidget.background': '#F6F6F6',
    'editorWidget.foreground': '#000000',
    'editorWidget.border': '#B8B8B8',
    'input.background': '#FFFFFF',
    'input.foreground': '#000000',
    'input.border': '#808080',
    'input.placeholderForeground': '#666666',
    focusBorder: '#0066CC',
    'list.activeSelectionBackground': '#CDE8FF',
    'list.activeSelectionForeground': '#000000',
    'list.hoverBackground': '#E8F3FC',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#80808055',
    'scrollbarSlider.hoverBackground': '#6060606F',
    'scrollbarSlider.activeBackground': '#40404088'
  }
})

function applyTheme(
  theme: 'system' | 'light' | 'dark',
  portalTheme?: 'light' | 'dark' | null
): void {
  const resolved =
    theme === 'system'
      ? (portalTheme ??
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
      : theme
  document.documentElement.setAttribute('data-theme', resolved)
  monaco.editor.setTheme(resolved === 'dark' ? 'monaco-notepad-dark' : 'monaco-notepad-light')
}

const container = document.getElementById('editor')
const statusBarElement = document.getElementById('statusbar')
const positionElement = document.getElementById('position')
const encodingElement = document.getElementById('encoding') as HTMLSelectElement | null
const eolElement = document.getElementById('eol') as HTMLSelectElement | null
const languageElement = document.getElementById('language') as HTMLSelectElement | null
const wordCountElement = document.getElementById('word-count')
const characterCountElement = document.getElementById('character-count')
const selectionCountElement = document.getElementById('selection-count')
const readOnlyElement = document.getElementById('read-only')
const largeFileElement = document.getElementById('large-file')
const fileSizeElement = document.getElementById('file-size')
const finalNewlineElement = document.getElementById('final-newline')
const followStatusElement = document.getElementById('follow-status')
const transientStatusElement = document.getElementById('transient-status')

if (!container) {
  throw new Error('Editor container not found')
}

if (
  !statusBarElement ||
  !positionElement ||
  !encodingElement ||
  !eolElement ||
  !languageElement ||
  !wordCountElement ||
  !characterCountElement ||
  !selectionCountElement ||
  !readOnlyElement ||
  !fileSizeElement ||
  !finalNewlineElement ||
  !followStatusElement ||
  !transientStatusElement
) {
  throw new Error('Status bar controls not found')
}

const statusBar = statusBarElement
const positionStatus = positionElement
const encodingStatus = encodingElement
const eolStatus = eolElement
const languageStatus = languageElement

const keyboardShortcuts = [
  { label: 'New', accelerator: 'Ctrl+N' },
  { label: 'Open', accelerator: 'Ctrl+O' },
  { label: 'Save', accelerator: 'Ctrl+S' },
  { label: 'Save As', accelerator: 'Ctrl+Shift+S' },
  { label: 'Print', accelerator: 'Ctrl+P' },
  { label: 'Find', accelerator: 'Ctrl+F' },
  { label: 'Replace', accelerator: 'Ctrl+H' },
  { label: 'Go To', accelerator: 'Ctrl+G' },
  { label: 'Toggle Bookmark', accelerator: 'Ctrl+Shift+F2' },
  { label: 'Next Bookmark', accelerator: 'F2' },
  { label: 'Previous Bookmark', accelerator: 'Shift+F2' },
  { label: 'Toggle Line Numbers', accelerator: 'Ctrl+Shift+F9' },
  { label: 'Full Screen', accelerator: 'F11' }
]

const languages = [
  { id: 'auto', label: 'Auto Detect' },
  { id: 'plaintext', label: 'Plain Text' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'json', label: 'JSON' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'shell', label: 'Shell' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'cpp', label: 'C / C++' }
]

languages.forEach((language) => {
  const option = document.createElement('option')
  option.value = language.id
  option.textContent = language.label
  languageStatus.appendChild(option)
})
const wordCountStatus = wordCountElement
const characterCountStatus = characterCountElement
const selectionCountStatus = selectionCountElement
const readOnlyStatus = readOnlyElement
const largeFileStatus = largeFileElement
const fileSizeStatus = fileSizeElement
const finalNewlineStatus = finalNewlineElement
const followStatus = followStatusElement
const transientStatus = transientStatusElement
const editorContainer = container
const shortcutsDialog = document.getElementById('shortcuts-dialog') as HTMLDivElement | null
const shortcutsList = document.getElementById('shortcuts-list') as HTMLUListElement | null
const compareView = document.getElementById('compare-view') as HTMLDivElement | null
const diffContainer = document.getElementById('diff-editor') as HTMLDivElement | null
const compareClose = document.getElementById('compare-close') as HTMLButtonElement | null
const compareKeep = document.getElementById('compare-keep') as HTMLButtonElement | null
const compareReload = document.getElementById('compare-reload') as HTMLButtonElement | null
const compareStatus = document.getElementById('compare-status') as HTMLSpanElement | null

if (shortcutsList) {
  keyboardShortcuts.forEach((shortcut) => {
    const li = document.createElement('li')
    li.innerHTML = `<span>${shortcut.label}</span><kbd>${shortcut.accelerator}</kbd>`
    shortcutsList.appendChild(li)
  })
}

const editor = monaco.editor.create(container, {
  value: '',
  language: 'plaintext',
  theme: 'monaco-notepad-light',
  ariaLabel: 'Document text',
  automaticLayout: true,
  lineNumbers: 'on',
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 18,
  glyphMargin: false,
  folding: false,
  renderWhitespace: 'none',
  renderControlCharacters: false,
  minimap: { enabled: false },
  guides: {
    indentation: false,
    bracketPairs: false,
    bracketPairsHorizontal: false,
    highlightActiveIndentation: false
  },
  bracketPairColorization: { enabled: false },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  renderLineHighlight: 'line',
  scrollBeyondLastLine: false,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Liberation Mono', 'DejaVu Sans Mono', monospace",
  fontSize: 14,
  lineHeight: 22,
  letterSpacing: 0.1,
  fontLigatures: false,
  cursorWidth: 2,
  padding: { top: 12, bottom: 12 },
  scrollbar: {
    useShadows: false,
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    verticalSliderSize: 8,
    horizontalSliderSize: 8
  }
})

let defaultNewDocumentEncoding: 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'windows1252' = 'utf8'
let defaultNewDocumentEol: 'LF' | 'CRLF' = 'LF'

const maybeModel = editor.getModel()

if (!maybeModel) {
  throw new Error('Editor model not found')
}

const model = maybeModel
const documentState = createDocumentState(model)
let recoveryTimer: number | null = null
let statisticsTimer: number | null = null
let documentGeneration = 0
let documentActions = Promise.resolve()
let editorPreferences = {
  trimTrailingWhitespaceOnSave: false,
  autoIndent: 'none' as 'none' | 'full',
  tabSize: 4 as 2 | 4 | 8,
  insertSpaces: true,
  largeFileWarningMiB: 20 as 10 | 20 | 50 | 100
}
let statusBarPreference = true
let wordWrapPreference = false
let primarySelectionPaste = false
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
let diskCompareModel: monaco.editor.ITextModel | null = null
let transientStatusTimer: number | null = null
let followActive = false
let followApplying = false
let followAutoScroll = true
let voluntaryReadOnlyBeforeFollow = false
const bookmarks = editor.createDecorationsCollection()

function showTransientStatus(message: string, error = false): void {
  if (transientStatusTimer !== null) window.clearTimeout(transientStatusTimer)
  transientStatus.textContent = message
  transientStatus.classList.toggle('status-error', error)
  transientStatus.hidden = false
  transientStatusTimer = window.setTimeout(() => {
    transientStatus.hidden = true
    transientStatus.textContent = ''
    transientStatusTimer = null
  }, 3500)
}

function syncFollowMenu(): void {
  void window.api.setFollowMenuState(followActive, followActive || documentState.filePath !== null)
}

// Native dialogs and asynchronous writes must finish before another document
// command can replace the buffer. Editing remains available during a write.
function runDocumentAction(action: () => Promise<unknown>): void {
  documentActions = documentActions
    .then(action)
    .then(() => undefined)
    .catch((error) => {
      console.error('Document action failed', error)
    })
}

function setShowWhitespace(enabled: boolean): void {
  editor.updateOptions({
    renderWhitespace: enabled ? 'all' : 'none',
    renderControlCharacters: enabled
  })
}

function setShowLineNumbers(enabled: boolean): void {
  editorContainer.classList.toggle('hide-line-numbers', !enabled)
  editor.updateOptions({
    lineNumbers: enabled ? 'on' : 'off',
    lineNumbersMinChars: enabled ? 3 : 0,
    lineDecorationsWidth: enabled ? 18 : 10
  })
}

function setLargeFileMode(enabled: boolean): void {
  documentState.largeFileMode = enabled
  editor.updateOptions({
    wordWrap: enabled ? 'off' : wordWrapPreference ? 'on' : 'off',
    renderLineHighlight: enabled ? 'none' : 'line',
    quickSuggestions: enabled ? false : undefined
  })
  if (enabled) {
    monaco.editor.setModelLanguage(model, 'plaintext')
  } else if (!documentState.languageOverride && documentState.filePath) {
    monaco.editor.setModelLanguage(model, languageForPath(documentState.filePath))
  }
  if (largeFileStatus) largeFileStatus.hidden = !enabled
  updateStatusBar()
}

function closeCompare(): void {
  diffEditor?.dispose()
  diffEditor = null
  diskCompareModel?.dispose()
  diskCompareModel = null
  if (compareView) compareView.hidden = true
  if (compareStatus) compareStatus.textContent = ''
  editor.focus()
}

async function openCompare(filePath: string, status = ''): Promise<void> {
  if (!compareView || !diffContainer || documentState.largeFileMode) return
  const disk = await window.api.readDiskForCompare(
    filePath,
    documentState.savedEncoding === 'windows1252' ? 'windows1252' : 'auto'
  )
  if (!disk || documentState.filePath !== filePath) return
  diffEditor?.dispose()
  diskCompareModel?.dispose()
  diskCompareModel = monaco.editor.createModel(disk.text, model.getLanguageId())
  diffEditor = monaco.editor.createDiffEditor(diffContainer, {
    readOnly: true,
    renderSideBySide: true,
    automaticLayout: true,
    originalEditable: false,
    minimap: { enabled: false }
  })
  diffEditor.setModel({ original: model, modified: diskCompareModel })
  compareView.hidden = false
  if (compareStatus) compareStatus.textContent = status
}

compareClose?.addEventListener('click', closeCompare)
compareKeep?.addEventListener('click', closeCompare)
compareReload?.addEventListener('click', () => {
  closeCompare()
  runDocumentAction(() => reloadFromDisk('reload'))
})

function applyEditorPreferences(preferences: typeof editorPreferences): void {
  editorPreferences = preferences
  editor.updateOptions({
    autoIndent: preferences.autoIndent,
    tabSize: preferences.tabSize,
    insertSpaces: preferences.insertSpaces,
    detectIndentation: false
  })
}

function executeReplacement(range: monaco.Range, text: string, source: string): void {
  if (model.getValueInRange(range) === text) return
  editor.pushUndoStop()
  editor.executeEdits(source, [{ range, text }])
  editor.pushUndoStop()
  editor.focus()
}

function wholeDocumentRange(): monaco.Range {
  const lastLine = model.getLineCount()
  return new monaco.Range(1, 1, lastLine, model.getLineMaxColumn(lastLine))
}

function affectedLineRange(selectionRequired: boolean): monaco.Range | null {
  const selection = editor.getSelection()
  if (!selection || (selectionRequired && selection.isEmpty())) return null
  if (selection.isEmpty()) return wholeDocumentRange()
  let endLine = selection.endLineNumber
  if (selection.endColumn === 1 && endLine > selection.startLineNumber) endLine--
  return new monaco.Range(selection.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine))
}

function transformRange(
  transform: (text: string) => string,
  selectionRequired: boolean,
  source: string
): void {
  const range = affectedLineRange(selectionRequired)
  if (!range) return
  executeReplacement(range, transform(model.getValueInRange(range)), source)
}

function updateFinalNewline(): void {
  const lastLine = model.getLineCount()
  const hasFinalNewline = lastLine > 1 && model.getLineLength(lastLine) === 0
  finalNewlineStatus.textContent = hasFinalNewline ? 'Final NL' : 'No Final NL'
}

function bookmarkLines(): number[] {
  return [...new Set(bookmarks.getRanges().map((range) => range.startLineNumber))].sort(
    (a, b) => a - b
  )
}

function toggleBookmark(): void {
  const line = editor.getPosition()?.lineNumber
  if (!line) return
  const lines = bookmarkLines()
  const next = lines.includes(line) ? lines.filter((value) => value !== line) : [...lines, line]
  bookmarks.set(
    next.map((lineNumber) => ({
      range: new monaco.Range(lineNumber, 1, lineNumber, 1),
      options: {
        description: 'Document bookmark',
        isWholeLine: true,
        showIfCollapsed: true,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        linesDecorationsClassName: 'bookmark-marker',
        linesDecorationsTooltip: 'Bookmark'
      }
    }))
  )
  editor.focus()
}

function goToBookmark(forward: boolean): void {
  const lines = bookmarkLines()
  if (!lines.length) return
  const current = editor.getPosition()?.lineNumber ?? 1
  const line = forward
    ? (lines.find((value) => value > current) ?? lines[0])
    : ([...lines].reverse().find((value) => value < current) ?? lines[lines.length - 1])
  editor.setPosition({ lineNumber: line, column: 1 })
  editor.revealLineInCenterIfOutsideViewport(line)
  editor.focus()
}

function convertSelectionCase(mode: 'upper' | 'lower' | 'title'): void {
  const edits = (editor.getSelections() ?? [])
    .filter((selection) => !selection.isEmpty())
    .map((range) => ({ range, text: convertCase(model.getValueInRange(range), mode) }))
    .filter((edit) => edit.text !== model.getValueInRange(edit.range))
  if (!edits.length) return

  editor.pushUndoStop()
  editor.executeEdits('convert-case', edits)
  editor.pushUndoStop()
  editor.focus()
}

function conciseTransformError(kind: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const oneLine = detail.replace(/\s+/g, ' ').slice(0, 140)
  return `${kind}: ${oneLine}`
}

function runSelectionTransform(
  source: string,
  transform: TextTransform,
  options: { wholeDocumentFallback?: boolean; kind: string }
): void {
  if (editor.getOption(monaco.editor.EditorOption.readOnly)) {
    showTransientStatus('Transform unavailable in read-only mode', true)
    return
  }
  const selections = editor.getSelections() ?? []
  const selected = selections.filter((selection) => !selection.isEmpty())
  let ranges: monaco.Selection[] | monaco.Range[] = selected
  if (!selected.length) {
    if (!options.wholeDocumentFallback) {
      showTransientStatus('Select text to transform', true)
      return
    }
    if (documentState.largeFileMode) {
      showTransientStatus('Whole-document transform unavailable in Large File Mode', true)
      return
    }
    ranges = [wholeDocumentRange()]
  }

  try {
    // Validate and transform every range before submitting any edit.
    const edits = ranges.map((range) => ({
      range,
      text: transform(model.getValueInRange(range))
    }))
    const changed = edits.filter((edit) => edit.text !== model.getValueInRange(edit.range))
    if (!changed.length) return
    editor.pushUndoStop()
    editor.executeEdits(source, changed)
    editor.pushUndoStop()
    editor.focus()
  } catch (error) {
    showTransientStatus(conciseTransformError(options.kind, error), true)
  }
}

function runTransformCommand(command: string): void {
  const indentation = editorPreferences.insertSpaces ? ' '.repeat(editorPreferences.tabSize) : '\t'
  switch (command) {
    case 'transform:format-json':
      runSelectionTransform(command, (text) => formatJson(text, indentation), {
        wholeDocumentFallback: true,
        kind: 'Invalid JSON'
      })
      break
    case 'transform:minify-json':
      runSelectionTransform(command, minifyJson, {
        wholeDocumentFallback: true,
        kind: 'Invalid JSON'
      })
      break
    case 'transform:format-xml':
      runSelectionTransform(command, (text) => formatXml(text, indentation), {
        wholeDocumentFallback: true,
        kind: 'Invalid XML'
      })
      break
    case 'transform:base64-encode':
      runSelectionTransform(command, encodeBase64, { kind: 'Base64 encode failed' })
      break
    case 'transform:base64-decode':
      runSelectionTransform(command, decodeBase64, { kind: 'Base64 decode failed' })
      break
    case 'transform:url-encode':
      runSelectionTransform(command, encodeUrl, { kind: 'URL encode failed' })
      break
    case 'transform:url-decode':
      runSelectionTransform(command, decodeUrl, { kind: 'URL decode failed' })
      break
    case 'transform:hex-encode':
      runSelectionTransform(command, encodeHex, { kind: 'Hex encode failed' })
      break
    case 'transform:hex-decode':
      runSelectionTransform(command, decodeHex, { kind: 'Hex decode failed' })
      break
  }
}

async function hashSelections(algorithm: 'sha256' | 'sha1' | 'md5'): Promise<void> {
  const selections = (editor.getSelections() ?? [])
    .filter((selection) => !selection.isEmpty())
    .map((selection) => model.getValueInRange(selection))
  if (!selections.length) {
    showTransientStatus('Select text to hash', true)
    return
  }
  try {
    await window.api.hashSelections(algorithm, selections)
    const label = algorithm === 'sha256' ? 'SHA-256' : algorithm === 'sha1' ? 'SHA-1' : 'MD5'
    showTransientStatus(`${label} copied to clipboard`)
  } catch (error) {
    showTransientStatus(conciseTransformError('Hash failed', error), true)
  }
}

function updateSelectionCount(): void {
  const count = (editor.getSelections() ?? []).reduce(
    (total, selection) =>
      total + (selection.isEmpty() ? 0 : countCharacters(model.getValueInRange(selection))),
    0
  )
  selectionCountStatus.hidden = count === 0
  selectionCountStatus.textContent = count ? `Selected ${count.toLocaleString()}` : ''
}

function updateStatistics(): void {
  if (statisticsTimer !== null) window.clearTimeout(statisticsTimer)
  statisticsTimer = null
  const text = model.getValue()
  wordCountStatus.textContent = `Words ${countWords(text).toLocaleString()}`
  characterCountStatus.textContent = `Chars ${countCharacters(text).toLocaleString()}`
  updateSelectionCount()
}

function scheduleStatistics(): void {
  if (statisticsTimer !== null) window.clearTimeout(statisticsTimer)
  statisticsTimer = window.setTimeout(updateStatistics, 150)
}

function capturePosition(): import('../../main/preferences').FilePosition {
  const pos = editor.getPosition() ?? { lineNumber: 1, column: 1 }
  return {
    line: pos.lineNumber,
    column: pos.column,
    scrollTop: editor.getScrollTop(),
    languageOverride: documentState.languageOverride ?? undefined,
    accessedAt: Date.now()
  }
}

let positionTimer: number | null = null
function schedulePositionSave(): void {
  if (positionTimer !== null) window.clearTimeout(positionTimer)
  positionTimer = window.setTimeout(() => {
    if (documentState.filePath) {
      void window.api.saveFilePosition(documentState.filePath, capturePosition())
    }
  }, 500)
}

async function refreshReadOnly(): Promise<void> {
  const filePath = documentState.filePath
  const generation = documentGeneration
  const readOnly = filePath ? await window.api.getFileReadOnly(filePath) : false
  if (generation !== documentGeneration || filePath !== documentState.filePath) return
  documentState.readOnly = readOnly
  applyReadOnlyState()
}

function applyReadOnlyState(): void {
  editor.updateOptions({
    readOnly:
      documentState.readOnly || documentState.voluntaryReadOnly || documentState.forcedReadOnly
  })
  updateStatusBar()
}

function updateFollowStatus(state: 'active' | 'paused' | 'waiting'): void {
  followStatus.hidden = !followActive
  followStatus.textContent =
    state === 'waiting'
      ? 'Following — waiting for file'
      : state === 'paused'
        ? 'Following — scroll paused'
        : 'Following'
}

function revealFollowEnd(): void {
  editor.revealLine(model.getLineCount())
  editor.setScrollTop(editor.getScrollHeight())
}

async function leaveFollowMode(): Promise<void> {
  if (!followActive) return
  await window.api.stopFollow()
  followActive = false
  documentState.voluntaryReadOnly = voluntaryReadOnlyBeforeFollow
  followStatus.hidden = true
  await refreshReadOnly()
  syncFollowMenu()
}

async function enterFollowMode(): Promise<void> {
  let filePath = documentState.filePath
  if (!filePath) {
    showTransientStatus('Follow File requires a saved file', true)
    return
  }

  if (isDocumentDirty(model, documentState)) {
    const choice = await window.api.confirmUnsavedChanges()
    if (choice === 'cancel') {
      syncFollowMenu()
      return
    }
    if (choice === 'save') {
      if (!(await saveDocument())) {
        syncFollowMenu()
        return
      }
      filePath = documentState.filePath
      if (!filePath) {
        syncFollowMenu()
        return
      }
    } else {
      const result = await window.api.openFilePath(
        filePath,
        documentState.savedEncoding === 'windows1252' ? 'windows1252' : 'auto'
      )
      if (!result) {
        syncFollowMenu()
        return
      }
      loadDocument(result)
    }
  }

  try {
    const result = await window.api.startFollow(filePath, documentState.encoding)
    voluntaryReadOnlyBeforeFollow = documentState.voluntaryReadOnly
    followActive = true
    followAutoScroll = true
    documentState.voluntaryReadOnly = true
    documentState.fileSize = result.size
    applyReadOnlyState()
    updateFollowStatus('active')
    syncFollowMenu()
    requestAnimationFrame(revealFollowEnd)
  } catch (error) {
    showTransientStatus(conciseTransformError('Follow File unavailable', error), true)
    syncFollowMenu()
  }
}

async function toggleFollowMode(): Promise<void> {
  if (followActive) await leaveFollowMode()
  else await enterFollowMode()
}

function toggleShortcutsDialog(): void {
  if (!shortcutsDialog) return
  const visible = shortcutsDialog.hidden
  shortcutsDialog.hidden = !visible
  if (!visible) {
    shortcutsDialog.querySelector('button')?.focus()
  } else {
    editor.focus()
  }
}

function setVoluntaryReadOnly(enabled: boolean): void {
  documentState.voluntaryReadOnly = enabled
  applyReadOnlyState()
}

function languageForPath(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const extension = fileName.split('.').pop()

  if (fileName === 'dockerfile' || fileName.endsWith('.dockerfile')) return 'dockerfile'

  switch (extension) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript'
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return 'typescript'
    case 'json':
    case 'jsonc':
      return 'json'
    case 'html':
    case 'htm':
      return 'html'
    case 'css':
      return 'css'
    case 'scss':
      return 'scss'
    case 'less':
      return 'less'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'py':
      return 'python'
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell'
    case 'xml':
    case 'svg':
    case 'xsd':
    case 'xsl':
      return 'xml'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'c':
    case 'h':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'hh':
    case 'hpp':
      return 'cpp'
    case 'cs':
      return 'csharp'
    case 'java':
      return 'java'
    case 'go':
      return 'go'
    case 'rs':
      return 'rust'
    case 'php':
    case 'phtml':
      return 'php'
    case 'rb':
      return 'ruby'
    case 'sql':
      return 'sql'
    case 'ini':
    case 'cfg':
    case 'conf':
    case 'properties':
    case 'toml':
      return 'ini'
    case 'ps1':
    case 'psm1':
      return 'powershell'
    case 'bat':
    case 'cmd':
      return 'bat'
    case 'graphql':
    case 'gql':
      return 'graphql'
    case 'lua':
      return 'lua'
    case 'pl':
    case 'pm':
      return 'perl'
    case 'r':
      return 'r'
    case 'swift':
      return 'swift'
    case 'kt':
    case 'kts':
      return 'kotlin'
    case 'vb':
      return 'vb'
    default:
      return 'plaintext'
  }
}

function getDocumentName(): string {
  if (!documentState.filePath) {
    return 'Untitled'
  }

  return documentState.filePath.split(/[\\/]/).pop() ?? documentState.filePath
}

function updateTitle(): void {
  const dirty = isDocumentDirty(model, documentState)
  document.title = `${dirty ? '*' : ''}${getDocumentName()} - Monaco Notepad`
}

function updateStatusBar(): void {
  const position = editor.getPosition()
  const line = position?.lineNumber ?? 1
  const column = position?.column ?? 1

  positionStatus.textContent = `Ln ${line}, Col ${column}`
  encodingStatus.value = documentState.encoding
  eolStatus.value = documentState.eol
  languageStatus.value = documentState.languageOverride ?? 'auto'
  readOnlyStatus.hidden = !(
    documentState.readOnly ||
    documentState.voluntaryReadOnly ||
    documentState.forcedReadOnly
  )
  readOnlyStatus.textContent = followActive
    ? 'Follow Lock'
    : documentState.forcedReadOnly
      ? 'Safe Open'
      : documentState.readOnly
        ? 'Read Only'
        : documentState.voluntaryReadOnly
          ? 'Locked'
          : 'Read Only'
  fileSizeStatus.hidden = documentState.fileSize === null
  fileSizeStatus.textContent =
    documentState.fileSize === null ? '' : formatFileSize(documentState.fileSize)
  updateFinalNewline()
}

function clearRecovery(): Promise<void> {
  if (recoveryTimer !== null) window.clearTimeout(recoveryTimer)
  recoveryTimer = null
  return window.api.clearRecovery()
}

function scheduleRecovery(): void {
  if (recoveryTimer !== null) window.clearTimeout(recoveryTimer)

  if (!isDocumentDirty(model, documentState)) {
    void clearRecovery()
    return
  }

  recoveryTimer = window.setTimeout(() => {
    recoveryTimer = null
    void window.api.saveRecovery({
      filePath: documentState.filePath,
      text: model.getValue(),
      encoding: documentState.encoding,
      eol: documentState.eol,
      position: documentState.filePath ? undefined : capturePosition()
    })
  }, 500)
}

async function confirmUnsavedChanges(): Promise<boolean> {
  if (!isDocumentDirty(model, documentState)) {
    return true
  }

  const choice = await window.api.confirmUnsavedChanges()

  if (choice === 'cancel') {
    return false
  }

  if (choice === 'discard') {
    return true
  }

  return (await saveDocument()) && !isDocumentDirty(model, documentState)
}

async function newDocument(): Promise<void> {
  await leaveFollowMode()
  closeCompare()
  if (documentState.filePath && positionTimer !== null) {
    window.clearTimeout(positionTimer)
    positionTimer = null
    void window.api.saveFilePosition(documentState.filePath, capturePosition())
  }

  if (!(await confirmUnsavedChanges())) {
    return
  }

  documentGeneration++
  bookmarks.clear()
  model.setValue('')
  model.setEOL(
    defaultNewDocumentEol === 'CRLF'
      ? monaco.editor.EndOfLineSequence.CRLF
      : monaco.editor.EndOfLineSequence.LF
  )
  monaco.editor.setModelLanguage(model, 'plaintext')

  documentState.filePath = null
  documentState.encoding = defaultNewDocumentEncoding
  documentState.savedEncoding = defaultNewDocumentEncoding
  documentState.eol = defaultNewDocumentEol
  documentState.savedVersionId = model.getAlternativeVersionId()
  documentState.readOnly = false
  documentState.voluntaryReadOnly = false
  documentState.forcedReadOnly = false
  documentState.protectedPath = null
  documentState.fileSize = null
  documentState.languageOverride = null
  documentState.largeFileMode = false
  setLargeFileMode(false)
  applyReadOnlyState()

  void window.api.watchFile(null)
  void clearRecovery()
  updateTitle()
  updateStatusBar()
  updateStatistics()
  syncFollowMenu()
  editor.focus()
}

function loadDocument(result: NonNullable<Awaited<ReturnType<typeof window.api.openFile>>>): void {
  closeCompare()
  documentGeneration++
  bookmarks.clear()
  model.setValue(result.text)
  model.setEOL(
    result.eol === 'CRLF'
      ? monaco.editor.EndOfLineSequence.CRLF
      : monaco.editor.EndOfLineSequence.LF
  )
  documentState.languageOverride = null
  documentState.filePath = result.filePath
  documentState.encoding = result.encoding
  documentState.savedEncoding = result.encoding
  documentState.eol = result.eol
  documentState.savedVersionId = model.getAlternativeVersionId()
  documentState.readOnly = result.readOnly
  documentState.voluntaryReadOnly = false
  documentState.forcedReadOnly = result.forcedReadOnly
  documentState.protectedPath = result.forcedReadOnly ? result.filePath : null
  documentState.fileSize = result.size
  setLargeFileMode(result.largeFileMode)
  applyReadOnlyState()
  void window.api.watchFile(result.filePath)
  void clearRecovery()
  updateTitle()
  updateStatusBar()
  updateStatistics()
  syncFollowMenu()

  void window.api.getFilePosition(result.filePath).then((stored) => {
    if (!stored) return
    requestAnimationFrame(() => {
      const line = Math.min(stored.line, model.getLineCount())
      const column = Math.min(stored.column, model.getLineMaxColumn(line))
      editor.setPosition({ lineNumber: line, column })
      editor.revealLineInCenterIfOutsideViewport(line)
      editor.setScrollTop(Math.min(stored.scrollTop, editor.getScrollHeight()))
      if (stored.languageOverride) {
        documentState.languageOverride = stored.languageOverride
        monaco.editor.setModelLanguage(model, stored.languageOverride)
      }
      updateStatusBar()
    })
  })

  editor.focus()
}

async function openFile(
  filePath?: string,
  bomlessEncoding: 'auto' | 'utf8' | 'windows1252' = 'auto'
): Promise<void> {
  await leaveFollowMode()
  if (documentState.filePath && positionTimer !== null) {
    window.clearTimeout(positionTimer)
    positionTimer = null
    void window.api.saveFilePosition(documentState.filePath, capturePosition())
  }

  if (!(await confirmUnsavedChanges())) {
    return
  }

  const versionBeforeOpen = model.getAlternativeVersionId()
  const encodingBeforeOpen = documentState.encoding
  const result = filePath
    ? await window.api.openFilePath(filePath, bomlessEncoding)
    : await window.api.openFile(bomlessEncoding)

  if (!result) {
    return
  }

  if (
    (versionBeforeOpen !== model.getAlternativeVersionId() ||
      encodingBeforeOpen !== documentState.encoding) &&
    !(await confirmUnsavedChanges())
  )
    return

  loadDocument(result)
}

async function saveDocument(saveAs = false, overwrite = false): Promise<boolean> {
  if (documentState.forcedReadOnly && !saveAs) {
    showTransientStatus('Safe Open: use Save As to save a text copy', true)
    return false
  }

  if (editorPreferences.trimTrailingWhitespaceOnSave) {
    executeReplacement(
      wholeDocumentRange(),
      trimTrailingWhitespace(model.getValue()),
      'trim-trailing-whitespace-on-save'
    )
  }
  const generation = documentGeneration
  const savedVersionId = model.getAlternativeVersionId()
  const savedEncoding = documentState.encoding
  const result = await window.api.saveFile({
    filePath: saveAs ? null : documentState.filePath,
    text: model.getValue(),
    encoding: savedEncoding,
    baselineCheck: !overwrite,
    protectedPath: documentState.protectedPath
  })

  if (result.action === 'conflict') {
    const choice = await window.api.resolveConflict({ filePath: documentState.filePath! })
    if (choice === 'reload') {
      return reloadFromDisk('reload')
    }
    if (choice === 'overwrite') {
      return saveDocument(false, true)
    }
    if (choice === 'save-as') {
      return saveDocumentAs()
    }
    return false
  }

  if (result.action !== 'saved') {
    await refreshReadOnly()
    return false
  }

  const filePath = result.filePath
  if (generation !== documentGeneration) return false
  documentState.filePath = filePath

  if (saveAs && documentState.forcedReadOnly) {
    documentState.forcedReadOnly = false
    documentState.protectedPath = null
  }

  // The user may have kept typing or changed encoding while the write ran.
  // Only the snapshot actually sent to the main process is now saved.
  documentState.savedEncoding = savedEncoding
  documentState.savedVersionId = savedVersionId
  documentState.fileSize = await window.api.getFileSize(filePath)

  if (!documentState.languageOverride) {
    monaco.editor.setModelLanguage(model, languageForPath(filePath))
  }
  scheduleRecovery()
  await refreshReadOnly()
  updateTitle()
  updateStatusBar()
  syncFollowMenu()
  editor.focus()

  return true
}

async function saveDocumentAs(): Promise<boolean> {
  return saveDocument(true)
}

async function saveCopy(): Promise<void> {
  await window.api.saveCopy({
    filePath: null,
    text: model.getValue(),
    encoding: documentState.encoding,
    protectedPath: documentState.protectedPath
  })
  editor.focus()
}

async function reloadFromDisk(action: 'reload' | 'revert'): Promise<boolean> {
  const filePath = documentState.filePath
  if (!filePath) return false
  if (isDocumentDirty(model, documentState) && !(await window.api.confirmDiscard(action)))
    return false
  const result = await window.api.openFilePath(
    filePath,
    documentState.savedEncoding === 'windows1252' ? 'windows1252' : 'auto'
  )
  if (result) {
    loadDocument(result)
    return true
  }
  return false
}

function addFinalNewline(): void {
  if (model.getValue().endsWith('\n')) return
  const lastLine = model.getLineCount()
  const position = new monaco.Range(
    lastLine,
    model.getLineMaxColumn(lastLine),
    lastLine,
    model.getLineMaxColumn(lastLine)
  )
  executeReplacement(position, model.getEOL(), 'add-final-newline')
}

function removeFinalNewline(): void {
  const text = model.getValue()
  if (!text.endsWith('\n')) return
  const without = text.endsWith('\r\n') ? text.slice(0, -2) : text.slice(0, -1)
  executeReplacement(wholeDocumentRange(), without, 'remove-final-newline')
}

model.onDidChangeContent(() => {
  documentState.eol = model.getEOL() === '\r\n' ? 'CRLF' : 'LF'
  updateTitle()
  updateStatusBar()
  if (!followApplying) {
    scheduleStatistics()
    scheduleRecovery()
    schedulePositionSave()
  }
})
editor.onDidChangeCursorPosition(() => {
  updateStatusBar()
  schedulePositionSave()
})
editor.onDidChangeCursorSelection(updateSelectionCount)
editor.onDidChangeCursorSelection(() => {
  if (!primarySelectionPaste) return
  const selection = editor.getSelection()
  if (!selection || selection.isEmpty()) return
  void window.api.setPrimarySelection(model.getValueInRange(selection))
})
editor.onDidScrollChange(() => {
  schedulePositionSave()
  if (!followActive) return
  const distanceFromBottom =
    editor.getScrollHeight() - editor.getScrollTop() - editor.getLayoutInfo().height
  followAutoScroll = distanceFromBottom <= 24
  updateFollowStatus(followAutoScroll ? 'active' : 'paused')
})

editorContainer.addEventListener('auxclick', (event) => {
  if (event.button !== 1 || !primarySelectionPaste) return
  event.preventDefault()
  if (editor.getOption(monaco.editor.EditorOption.readOnly)) return
  void window.api.getPrimarySelection().then((text) => {
    if (!text || editor.getOption(monaco.editor.EditorOption.readOnly)) return
    const selection = editor.getSelection()
    if (!selection) return
    editor.executeEdits('primary-selection-paste', [{ range: selection, text }])
    editor.focus()
  })
})

function setEncoding(encoding: typeof documentState.encoding): void {
  if (encoding === documentState.encoding) return
  documentState.encoding = encoding
  updateTitle()
  updateStatusBar()
  scheduleRecovery()
  editor.focus()
}

function setEol(eol: typeof documentState.eol): void {
  if (eol === documentState.eol) return
  model.setEOL(
    eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF
  )
  documentState.eol = eol
  updateTitle()
  updateStatusBar()
  editor.focus()
}

function setLanguage(languageId: string): void {
  if (languageId === 'auto') {
    documentState.languageOverride = null
    if (documentState.filePath) {
      monaco.editor.setModelLanguage(model, languageForPath(documentState.filePath))
    } else {
      monaco.editor.setModelLanguage(model, 'plaintext')
    }
  } else {
    documentState.languageOverride = languageId
    monaco.editor.setModelLanguage(model, languageId)
  }
  updateStatusBar()
  editor.focus()
}

encodingStatus.addEventListener('change', () => {
  setEncoding(encodingStatus.value as typeof documentState.encoding)
})

eolStatus.addEventListener('change', () => {
  setEol(eolStatus.value as typeof documentState.eol)
})

languageStatus.addEventListener('change', () => {
  setLanguage(languageStatus.value)
})

window.api.onOpenFileRequested((filePath, encoding) => {
  runDocumentAction(() => openFile(filePath, encoding))
})

window.api.onFollowUpdate((update) => {
  if (!followActive) return
  if (update.kind === 'waiting') {
    updateFollowStatus('waiting')
    return
  }

  followApplying = true
  try {
    if (update.kind === 'reset') {
      model.setValue(update.text)
      const message =
        update.reason === 'truncated'
          ? 'File truncated; follow restarted'
          : update.reason === 'rotated'
            ? 'File replaced; follow restarted'
            : 'File recreated; follow restarted'
      showTransientStatus(message)
    } else if (update.text) {
      const line = model.getLineCount()
      const column = model.getLineMaxColumn(line)
      model.applyEdits([
        {
          range: new monaco.Range(line, column, line, column),
          text: update.text
        }
      ])
    }
  } finally {
    followApplying = false
  }
  documentState.savedVersionId = model.getAlternativeVersionId()
  documentState.fileSize = update.to
  documentState.eol = model.getEOL() === '\r\n' ? 'CRLF' : 'LF'
  updateTitle()
  updateStatusBar()
  if (followAutoScroll) requestAnimationFrame(revealFollowEnd)
  updateFollowStatus(followAutoScroll ? 'active' : 'paused')
})

window.api.onFollowError((message) => {
  if (followActive) showTransientStatus(`Follow File: ${message}`, true)
})

window.api.onExternalFileChange((change) => {
  const generation = documentGeneration
  runDocumentAction(async () => {
    try {
      if (generation !== documentGeneration || change.filePath !== documentState.filePath) return
      if (followActive) return
      await refreshReadOnly()
      if (diffEditor && !compareView?.hidden) {
        if (!documentState.largeFileMode) {
          await openCompare(change.filePath, 'Disk changed again — comparison refreshed.')
        }
        return
      }
      const choice = await window.api.confirmExternalFileChange({
        ...change,
        dirty: isDocumentDirty(model, documentState),
        largeFileMode: documentState.largeFileMode
      })

      if (choice === 'compare') {
        if (!documentState.largeFileMode) await openCompare(change.filePath)
        return
      }

      if (
        choice === 'reload' &&
        generation === documentGeneration &&
        change.filePath === documentState.filePath
      ) {
        const versionBeforeReload = model.getAlternativeVersionId()
        const encodingBeforeReload = documentState.encoding
        const result = await window.api.openFilePath(
          change.filePath,
          documentState.savedEncoding === 'windows1252' ? 'windows1252' : 'auto'
        )
        if (result) {
          if (
            (versionBeforeReload !== model.getAlternativeVersionId() ||
              encodingBeforeReload !== documentState.encoding) &&
            !(await confirmUnsavedChanges())
          )
            return
          loadDocument(result)
        }
      }
    } finally {
      await window.api.externalFileChangeHandled()
      editor.focus()
    }
  })
})

window.api.onCloseRequested(() => {
  runDocumentAction(async () => {
    if (documentState.filePath && positionTimer !== null) {
      window.clearTimeout(positionTimer)
      positionTimer = null
      void window.api.saveFilePosition(documentState.filePath, capturePosition())
    }
    if (!documentState.filePath && isDocumentDirty(model, documentState)) {
      await window.api.saveRecovery({
        filePath: null,
        text: model.getValue(),
        encoding: documentState.encoding,
        eol: documentState.eol,
        position: capturePosition()
      })
      await window.api.approveClose()
    } else if (await confirmUnsavedChanges()) {
      await clearRecovery()
      await window.api.approveClose()
    }
  })
})

window.api.onStatusBar((visible) => {
  statusBarPreference = visible
  statusBar.style.display = visible ? '' : 'none'
  editor.layout()
})

window.api.onWordWrap((enabled) => {
  editor.updateOptions({
    wordWrap: enabled ? 'on' : 'off'
  })
})

window.api.onShowWhitespace(setShowWhitespace)
window.api.onShowLineNumbers(setShowLineNumbers)
window.api.onEditorPreferences(applyEditorPreferences)
window.api.onFullScreen((enabled) => {
  statusBar.style.display = enabled || !statusBarPreference ? 'none' : ''
  editor.layout()
})

const modifyingCommands: string[] = [
  'delete',
  'duplicate-line',
  'move-line-up',
  'move-line-down',
  'indent',
  'outdent',
  'tabs-to-spaces',
  'spaces-to-tabs',
  'sort-lines-asc',
  'sort-lines-desc',
  'remove-duplicate-lines',
  'delete-empty-lines',
  'trim-trailing-whitespace',
  'toggle-line-comment',
  'add-final-newline',
  'remove-final-newline',
  'case-upper',
  'case-lower',
  'case-title',
  'time-date',
  'bookmark-toggle',
  'bookmark-clear'
]

window.api.onMenuCommand((command) => {
  if (
    (modifyingCommands.includes(command) || command.startsWith('transform:')) &&
    editor.getOption(monaco.editor.EditorOption.readOnly)
  ) {
    showTransientStatus('Command unavailable in read-only mode', true)
    return
  }
  if (followActive && ['save', 'save-as', 'reload', 'revert'].includes(command)) {
    showTransientStatus('Exit Follow File before saving or reloading', true)
    return
  }
  switch (command) {
    case 'new':
      runDocumentAction(newDocument)
      break
    case 'open':
      runDocumentAction(() => openFile())
      break
    case 'open-ansi':
      runDocumentAction(() => openFile(undefined, 'windows1252'))
      break
    case 'save':
      runDocumentAction(() => saveDocument())
      break
    case 'save-as':
      runDocumentAction(saveDocumentAs)
      break
    case 'save-copy':
      runDocumentAction(saveCopy)
      break
    case 'print':
      void window.api.printDocument({
        title: documentState.filePath?.split(/[\\/]/).pop() ?? 'Untitled',
        text: model.getValue(),
        fontFamily: editor.getOption(monaco.editor.EditorOption.fontFamily)
      })
      break
    case 'reload':
    case 'revert':
      runDocumentAction(() => reloadFromDisk(command))
      break
    case 'copy-full-path':
      if (documentState.filePath) void window.api.copyPath(documentState.filePath)
      break
    case 'copy-filename':
      if (documentState.filePath) void window.api.copyPath(documentState.filePath, true)
      break
    case 'reveal-file':
      if (documentState.filePath) void window.api.revealFile(documentState.filePath)
      break
    case 'open-terminal':
      void window.api.openTerminal(documentState.filePath)
      break
    case 'file-properties':
      if (documentState.filePath)
        void window.api.showFileProperties(documentState.filePath, {
          encoding: documentState.encoding,
          eol: documentState.eol,
          language: model.getLanguageId()
        })
      break
    case 'sha256':
      if (documentState.filePath)
        void window.api.showSha256(documentState.filePath, isDocumentDirty(model, documentState))
      break
    case 'transform:format-json':
    case 'transform:minify-json':
    case 'transform:format-xml':
    case 'transform:base64-encode':
    case 'transform:base64-decode':
    case 'transform:url-encode':
    case 'transform:url-decode':
    case 'transform:hex-encode':
    case 'transform:hex-decode':
      runTransformCommand(command)
      break
    case 'hash:sha256':
    case 'hash:sha1':
    case 'hash:md5':
      void hashSelections(command.slice('hash:'.length) as 'sha256' | 'sha1' | 'md5')
      break
    case 'follow-file':
      runDocumentAction(toggleFollowMode)
      break
    case 'undo':
      editor.trigger('menu', 'undo', null)
      break
    case 'redo':
      editor.trigger('menu', 'redo', null)
      break
    case 'select-all':
      editor.trigger('menu', 'editor.action.selectAll', null)
      break
    case 'delete':
      editor.trigger('menu', 'deleteRight', null)
      break
    case 'duplicate-line':
      editor.trigger('menu', 'editor.action.copyLinesDownAction', null)
      break
    case 'move-line-up':
      editor.trigger('menu', 'editor.action.moveLinesUpAction', null)
      break
    case 'move-line-down':
      editor.trigger('menu', 'editor.action.moveLinesDownAction', null)
      break
    case 'select-line':
      {
        const line = editor.getPosition()?.lineNumber
        if (line) {
          const nextLine = Math.min(line + 1, model.getLineCount())
          editor.setSelection(
            line < model.getLineCount()
              ? new monaco.Selection(line, 1, nextLine, 1)
              : new monaco.Selection(line, 1, line, model.getLineMaxColumn(line))
          )
        }
      }
      break
    case 'indent':
      editor.trigger('menu', 'editor.action.indentLines', null)
      break
    case 'outdent':
      editor.trigger('menu', 'editor.action.outdentLines', null)
      break
    case 'tabs-to-spaces':
      transformRange(
        (text) => tabsToSpaces(text, editorPreferences.tabSize),
        false,
        'tabs-to-spaces'
      )
      break
    case 'spaces-to-tabs':
      transformRange(
        (text) => indentationSpacesToTabs(text, editorPreferences.tabSize),
        false,
        'spaces-to-tabs'
      )
      break
    case 'sort-lines-asc':
      transformRange((text) => sortLines(text), true, 'sort-lines-ascending')
      break
    case 'sort-lines-desc':
      transformRange((text) => sortLines(text, true), true, 'sort-lines-descending')
      break
    case 'remove-duplicate-lines':
      transformRange(removeDuplicateLines, true, 'remove-duplicate-lines')
      break
    case 'delete-empty-lines':
      transformRange(deleteEmptyLines, false, 'delete-empty-lines')
      break
    case 'trim-trailing-whitespace':
      executeReplacement(
        wholeDocumentRange(),
        trimTrailingWhitespace(model.getValue()),
        'trim-trailing-whitespace'
      )
      break
    case 'matching-bracket':
      editor.trigger('menu', 'editor.action.jumpToBracket', null)
      break
    case 'toggle-line-comment':
      editor.trigger('menu', 'editor.action.commentLine', null)
      break
    case 'add-final-newline':
      addFinalNewline()
      break
    case 'remove-final-newline':
      removeFinalNewline()
      break
    case 'case-upper':
    case 'case-lower':
    case 'case-title':
      convertSelectionCase(command.slice('case-'.length) as 'upper' | 'lower' | 'title')
      break
    case 'bookmark-toggle':
      toggleBookmark()
      break
    case 'bookmark-next':
      goToBookmark(true)
      break
    case 'bookmark-previous':
      goToBookmark(false)
      break
    case 'bookmark-clear':
      bookmarks.clear()
      editor.focus()
      break
    case 'find':
      editor.trigger('menu', 'actions.find', null)
      break
    case 'find-next':
      editor.trigger('menu', 'editor.action.nextMatchFindAction', null)
      break
    case 'replace':
      editor.trigger('menu', 'editor.action.startFindReplaceAction', null)
      break
    case 'go-to':
      editor.trigger('menu', 'editor.action.gotoLine', null)
      break
    case 'time-date': {
      const selection = editor.getSelection()

      if (!selection) {
        break
      }

      editor.executeEdits('time-date', [
        {
          range: selection,
          text: new Date().toLocaleString()
        }
      ])
      break
    }
    case 'zoom-in':
      editor.trigger('menu', 'editor.action.fontZoomIn', null)
      break
    case 'zoom-out':
      editor.trigger('menu', 'editor.action.fontZoomOut', null)
      break
    case 'zoom-reset':
      editor.trigger('menu', 'editor.action.fontZoomReset', null)
      break
    case 'encoding:utf8':
    case 'encoding:utf8-bom':
    case 'encoding:utf16le':
    case 'encoding:utf16be':
    case 'encoding:windows1252':
      setEncoding(command.slice('encoding:'.length) as typeof documentState.encoding)
      break
    case 'eol:LF':
    case 'eol:CRLF':
      setEol(command.slice('eol:'.length) as typeof documentState.eol)
      break
    case 'preferences':
      void window.api.openPreferencesDialog()
      break
    case 'toggle-read-only':
      if (followActive) showTransientStatus('Read-only state is locked while following', true)
      else setVoluntaryReadOnly(!documentState.voluntaryReadOnly)
      break
    case 'show-keyboard-shortcuts':
      toggleShortcutsDialog()
      break
    case 'language:auto':
    case 'language:plaintext':
    case 'language:markdown':
    case 'language:json':
    case 'language:javascript':
    case 'language:typescript':
    case 'language:python':
    case 'language:shell':
    case 'language:html':
    case 'language:css':
    case 'language:cpp':
      setLanguage(command.slice('language:'.length))
      break
  }
})

window.addEventListener('keydown', (event) => {
  if (event.metaKey || !event.ctrlKey) return

  if (event.key === 'F9' && event.shiftKey) {
    event.preventDefault()
    const enabled = editorContainer.classList.contains('hide-line-numbers')
    setShowLineNumbers(enabled)
    void window.api.preferences.set('showLineNumbers', enabled)
  } else if (
    event.key === '+' ||
    (event.code === 'Equal' && event.shiftKey) ||
    event.code === 'NumpadAdd'
  ) {
    event.preventDefault()
    editor.trigger('keyboard', 'editor.action.fontZoomIn', null)
  } else if (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract') {
    event.preventDefault()
    editor.trigger('keyboard', 'editor.action.fontZoomOut', null)
  } else if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') {
    event.preventDefault()
    editor.trigger('keyboard', 'editor.action.fontZoomReset', null)
  }
})

window.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
})

window.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files[0]
  if (!file) return

  event.preventDefault()
  const filePath = window.api.getPathForFile(file)
  if (filePath) runDocumentAction(() => openFile(filePath))
})

window.addEventListener('focus', () => {
  void refreshReadOnly()
})

updateTitle()
updateStatusBar()
updateStatistics()

void window.api.preferences.getAll().then((preferences) => {
  applyTheme(preferences.theme)
  editor.updateOptions({
    fontFamily: preferences.fontFamily,
    fontSize: preferences.fontSize
  })
  defaultNewDocumentEncoding = preferences.defaultEncoding
  defaultNewDocumentEol = preferences.defaultEol
  primarySelectionPaste = preferences.primarySelectionPaste
  setShowWhitespace(preferences.showWhitespace)
  setShowLineNumbers(preferences.showLineNumbers)
  wordWrapPreference = preferences.wordWrap
  editor.updateOptions({
    wordWrap: wordWrapPreference ? 'on' : 'off'
  })
  statusBarPreference = preferences.statusBarVisible
  statusBar.style.display = preferences.statusBarVisible ? '' : 'none'
  editor.layout()
  applyEditorPreferences({
    trimTrailingWhitespaceOnSave: preferences.trimTrailingWhitespaceOnSave,
    autoIndent: preferences.autoIndent,
    tabSize: preferences.tabSize,
    insertSpaces: preferences.insertSpaces,
    largeFileWarningMiB: preferences.largeFileWarningMiB
  })
})

void window.api.getZoomLevel().then((zoomLevel) => {
  monaco.editor.EditorZoom.setZoomLevel(zoomLevel)
})

window.api.onSystemThemeChanged(() => {
  void window.api.preferences.getAll().then((preferences) => {
    if (preferences.theme === 'system') applyTheme('system')
  })
})

window.api.onPortalThemeChanged((theme) => {
  void window.api.preferences.getAll().then((preferences) => {
    if (preferences.theme === 'system') applyTheme('system', theme)
  })
})

window.api.onPreferencesChanged((changes) => {
  if (changes.theme) applyTheme(changes.theme)
  if (changes.defaultEncoding) defaultNewDocumentEncoding = changes.defaultEncoding
  if (changes.defaultEol) defaultNewDocumentEol = changes.defaultEol
  if (changes.primarySelectionPaste !== undefined)
    primarySelectionPaste = changes.primarySelectionPaste
  if (changes.fontFamily || changes.fontSize) {
    editor.updateOptions({
      fontFamily: changes.fontFamily,
      fontSize: changes.fontSize
    })
  }
  if (changes.showWhitespace !== undefined) setShowWhitespace(changes.showWhitespace)
  if (changes.showLineNumbers !== undefined) setShowLineNumbers(changes.showLineNumbers)
  if (changes.wordWrap !== undefined) {
    wordWrapPreference = changes.wordWrap
    editor.updateOptions({ wordWrap: changes.wordWrap ? 'on' : 'off' })
  }
  if (changes.statusBarVisible !== undefined) {
    statusBarPreference = changes.statusBarVisible
    statusBar.style.display = changes.statusBarVisible ? '' : 'none'
    editor.layout()
  }
  if (
    changes.trimTrailingWhitespaceOnSave !== undefined ||
    changes.autoIndent !== undefined ||
    changes.tabSize !== undefined ||
    changes.insertSpaces !== undefined ||
    changes.largeFileWarningMiB !== undefined
  ) {
    applyEditorPreferences({
      trimTrailingWhitespaceOnSave:
        changes.trimTrailingWhitespaceOnSave ?? editorPreferences.trimTrailingWhitespaceOnSave,
      autoIndent: changes.autoIndent ?? editorPreferences.autoIndent,
      tabSize: changes.tabSize ?? editorPreferences.tabSize,
      insertSpaces: changes.insertSpaces ?? editorPreferences.insertSpaces,
      largeFileWarningMiB: changes.largeFileWarningMiB ?? editorPreferences.largeFileWarningMiB
    })
  }
  syncFollowMenu()
})

monaco.editor.EditorZoom.onDidChangeZoomLevel((zoomLevel) => {
  void window.api.setZoomLevel(zoomLevel)
})

runDocumentAction(async () => {
  const recovery = await window.api.checkRecovery()

  if (recovery) {
    documentGeneration++
    bookmarks.clear()
    model.setValue(recovery.text)
    model.setEOL(
      recovery.eol === 'CRLF'
        ? monaco.editor.EndOfLineSequence.CRLF
        : monaco.editor.EndOfLineSequence.LF
    )
    monaco.editor.setModelLanguage(
      model,
      recovery.filePath ? languageForPath(recovery.filePath) : 'plaintext'
    )
    documentState.filePath = recovery.filePath
    documentState.encoding = recovery.encoding
    documentState.savedEncoding = recovery.encoding
    documentState.eol = recovery.eol
    documentState.savedVersionId = 0
    void window.api.watchFile(recovery.filePath)
    await refreshReadOnly()
    if (recovery.position) {
      const line = Math.min(recovery.position.line, model.getLineCount())
      const column = Math.min(recovery.position.column, model.getLineMaxColumn(line))
      documentState.languageOverride = recovery.position.languageOverride ?? null
      if (documentState.languageOverride)
        monaco.editor.setModelLanguage(model, documentState.languageOverride)
      requestAnimationFrame(() => {
        editor.setPosition({ lineNumber: line, column })
        editor.setScrollTop(Math.min(recovery.position!.scrollTop, editor.getScrollHeight()))
      })
    }
    updateTitle()
    updateStatusBar()
    updateStatistics()
  }

  await window.api.rendererReady(Boolean(recovery))
  syncFollowMenu()
  editor.focus()
})
