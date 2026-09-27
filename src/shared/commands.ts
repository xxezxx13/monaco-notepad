export const MENU_COMMAND_IDS = [
  'new',
  'open',
  'open-ansi',
  'reopen-encoding:utf8',
  'reopen-encoding:utf8-bom',
  'reopen-encoding:utf16le',
  'reopen-encoding:utf16be',
  'reopen-encoding:windows1252',
  'save',
  'save-as',
  'save-copy',
  'print',
  'reload',
  'revert',
  'copy-full-path',
  'copy-filename',
  'reveal-file',
  'open-terminal',
  'document-inspector',
  'sha256',
  'undo',
  'redo',
  'select-all',
  'delete',
  'filter-lines',
  'regex-extract',
  'find',
  'find-next',
  'find-previous',
  'replace',
  'go-to',
  'time-date',
  'duplicate-line',
  'move-line-up',
  'move-line-down',
  'select-line',
  'indent',
  'outdent',
  'tabs-to-spaces',
  'spaces-to-tabs',
  'sort-lines-asc',
  'sort-lines-desc',
  'sort-lines-natural-asc',
  'sort-lines-natural-desc',
  'sort-lines-numeric-asc',
  'sort-lines-numeric-desc',
  'reverse-lines',
  'join-lines',
  'split-lines-commas',
  'remove-duplicate-lines',
  'delete-empty-lines',
  'trim-trailing-whitespace',
  'matching-bracket',
  'toggle-line-comment',
  'add-final-newline',
  'remove-final-newline',
  'case-upper',
  'case-lower',
  'case-title',
  'transform:format-json',
  'transform:minify-json',
  'transform:format-xml',
  'transform:base64-encode',
  'transform:base64-decode',
  'transform:url-encode',
  'transform:url-decode',
  'transform:hex-encode',
  'transform:hex-decode',
  'transform:reflow-72',
  'transform:reflow-80',
  'transform:normalize-nfc',
  'transform:normalize-nfd',
  'transform:normalize-nfkc',
  'transform:normalize-nfkd',
  'hash:sha256',
  'hash:sha1',
  'hash:md5',
  'follow-file',
  'bookmark-toggle',
  'bookmark-next',
  'bookmark-previous',
  'bookmark-clear',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'encoding:utf8',
  'encoding:utf8-bom',
  'encoding:utf16le',
  'encoding:utf16be',
  'encoding:windows1252',
  'eol:LF',
  'eol:CRLF',
  'preferences',
  'toggle-read-only',
  'show-keyboard-shortcuts',
  'language:auto',
  'language:plaintext',
  'language:markdown',
  'language:json',
  'language:javascript',
  'language:typescript',
  'language:python',
  'language:shell',
  'language:html',
  'language:css',
  'language:cpp'
] as const

export type MenuCommand = (typeof MENU_COMMAND_IDS)[number]

export type MenuContextState = {
  followActive: boolean
  followEnabled: boolean
  readOnly: boolean
  readOnlyToggleEnabled: boolean
}

export type DirectShortcutId = 'show-line-numbers' | 'full-screen'
type ShortcutDefinitionId = MenuCommand | DirectShortcutId

export type ShortcutDefinition = {
  id: ShortcutDefinitionId
  label: string
  menuLabel?: string
  accelerator: string
  registerAccelerator?: false
}

export const SHORTCUT_DEFINITIONS = [
  {
    id: 'new',
    label: 'New',
    accelerator: 'CmdOrCtrl+N'
  },
  {
    id: 'open',
    label: 'Open',
    menuLabel: 'Open...',
    accelerator: 'CmdOrCtrl+O'
  },
  {
    id: 'reload',
    label: 'Reload from Disk',
    accelerator: 'CmdOrCtrl+Shift+R'
  },
  {
    id: 'save',
    label: 'Save',
    accelerator: 'CmdOrCtrl+S'
  },
  {
    id: 'save-as',
    label: 'Save As',
    menuLabel: 'Save As...',
    accelerator: 'CmdOrCtrl+Shift+S'
  },
  {
    id: 'print',
    label: 'Print',
    menuLabel: 'Print...',
    accelerator: 'CmdOrCtrl+P'
  },
  {
    id: 'undo',
    label: 'Undo',
    accelerator: 'CmdOrCtrl+Z'
  },
  {
    id: 'redo',
    label: 'Redo',
    accelerator: 'Ctrl+Y'
  },
  {
    id: 'toggle-line-comment',
    label: 'Toggle Line Comment',
    accelerator: 'CmdOrCtrl+/',
    registerAccelerator: false
  },
  {
    id: 'matching-bracket',
    label: 'Go to Matching Bracket',
    accelerator: 'CmdOrCtrl+Shift+\\',
    registerAccelerator: false
  },
  {
    id: 'filter-lines',
    label: 'Filter Lines',
    menuLabel: 'Filter Lines...',
    accelerator: 'CmdOrCtrl+Shift+F'
  },
  {
    id: 'find',
    label: 'Find',
    menuLabel: 'Find...',
    accelerator: 'CmdOrCtrl+F'
  },
  {
    id: 'find-next',
    label: 'Find Next',
    accelerator: 'F3'
  },
  {
    id: 'find-previous',
    label: 'Find Previous',
    accelerator: 'Shift+F3'
  },
  {
    id: 'replace',
    label: 'Replace',
    menuLabel: 'Replace...',
    accelerator: 'CmdOrCtrl+H'
  },
  {
    id: 'go-to',
    label: 'Go To',
    menuLabel: 'Go To...',
    accelerator: 'CmdOrCtrl+G'
  },
  {
    id: 'bookmark-toggle',
    label: 'Toggle Bookmark',
    accelerator: 'Ctrl+Shift+F2'
  },
  {
    id: 'bookmark-next',
    label: 'Next Bookmark',
    accelerator: 'F2'
  },
  {
    id: 'bookmark-previous',
    label: 'Previous Bookmark',
    accelerator: 'Shift+F2'
  },
  {
    id: 'select-all',
    label: 'Select All',
    accelerator: 'CmdOrCtrl+A'
  },
  {
    id: 'time-date',
    label: 'Time/Date',
    accelerator: 'F5'
  },
  {
    id: 'toggle-read-only',
    label: 'Read Only',
    accelerator: 'Ctrl+Alt+R'
  },
  {
    id: 'preferences',
    label: 'Preferences',
    menuLabel: 'Preferences...',
    accelerator: 'CmdOrCtrl+,'
  },
  {
    id: 'show-line-numbers',
    label: 'Show Line Numbers',
    accelerator: 'Ctrl+Shift+F9'
  },
  {
    id: 'full-screen',
    label: 'Full Screen',
    accelerator: 'F11'
  },
  {
    id: 'zoom-in',
    label: 'Zoom In',
    accelerator: 'CmdOrCtrl+Plus',
    registerAccelerator: false
  },
  {
    id: 'zoom-out',
    label: 'Zoom Out',
    accelerator: 'CmdOrCtrl+-',
    registerAccelerator: false
  },
  {
    id: 'zoom-reset',
    label: 'Reset Zoom',
    accelerator: 'CmdOrCtrl+0',
    registerAccelerator: false
  }
] as const satisfies readonly ShortcutDefinition[]

export type ShortcutId = (typeof SHORTCUT_DEFINITIONS)[number]['id']

export function getShortcutDefinition(id: ShortcutId): ShortcutDefinition {
  const definition = SHORTCUT_DEFINITIONS.find((shortcut) => shortcut.id === id)

  if (!definition) {
    throw new Error(`Unknown shortcut: ${id}`)
  }

  return definition
}

export function shortcutDisplayAccelerator(accelerator: string): string {
  return accelerator.replace(/^CmdOrCtrl\+/, 'Ctrl+').replace(/Plus$/, '+')
}

export const KEYBOARD_SHORTCUTS = SHORTCUT_DEFINITIONS.map(({ label, accelerator }) => ({
  label,
  accelerator: shortcutDisplayAccelerator(accelerator)
}))
const EXPLICIT_MODIFYING_COMMAND_IDS = [
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
  'sort-lines-natural-asc',
  'sort-lines-natural-desc',
  'sort-lines-numeric-asc',
  'sort-lines-numeric-desc',
  'reverse-lines',
  'join-lines',
  'split-lines-commas',
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
] as const satisfies readonly MenuCommand[]

const modifyingCommands = new Set<MenuCommand>(EXPLICIT_MODIFYING_COMMAND_IDS)

export function isModifyingCommand(command: MenuCommand): boolean {
  return modifyingCommands.has(command) || command.startsWith('transform:')
}
