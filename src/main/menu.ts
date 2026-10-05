import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  type MenuItemConstructorOptions
} from 'electron'
import { existsSync } from 'node:fs'
import {
  MENU_COMMAND_IDS,
  getShortcutDefinition,
  isModifyingCommand,
  type MenuCommand,
  type MenuContextState,
  type ShortcutId
} from '../shared/commands'
import { preferences } from './preferences'
import type { BomlessFileEncoding } from './files'

const maximumRecentFiles = 10

const followBlockedCommands = new Set<MenuCommand>([
  'save',
  'save-as',
  'reload',
  'revert',
  'reopen-encoding:utf8',
  'reopen-encoding:utf8-bom',
  'reopen-encoding:utf16le',
  'reopen-encoding:utf16be',
  'reopen-encoding:windows1252'
])

const defaultMenuContextState: MenuContextState = {
  followActive: false,
  followEnabled: false,
  readOnly: false,
  readOnlyToggleEnabled: true
}

const menuContextStates = new WeakMap<BrowserWindow, MenuContextState>()
const documentWindows = new WeakSet<BrowserWindow>()

function menuContextStateFor(window: BrowserWindow): MenuContextState {
  return menuContextStates.get(window) ?? defaultMenuContextState
}

function focusedDocumentWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) {
    if (focused.isDestroyed() || !documentWindows.has(focused)) return null
    return focused
  }

  const documents = BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && documentWindows.has(window)
  )
  return documents.length === 1 ? documents[0] : null
}

function availableDocumentWindow(): BrowserWindow | null {
  const focused = focusedDocumentWindow()
  if (focused) return focused

  return (
    BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && documentWindows.has(window)
    ) ?? null
  )
}

function sendToFocusedDocument(channel: string, ...args: unknown[]): void {
  const window = focusedDocumentWindow()
  if (!window) return
  window.webContents.send(channel, ...args)
}

function sendToDocumentWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || !documentWindows.has(window)) continue
    window.webContents.send(channel, ...args)
  }
}

function menuCommandId(command: string): string {
  return `command:${command}`
}

function applyMenuContextState(menu: Menu, state: MenuContextState): void {
  const followItem = menu.getMenuItemById('follow-file')
  if (followItem) {
    followItem.checked = state.followActive
    followItem.enabled = state.followEnabled
  }

  const readOnlyItem = menu.getMenuItemById('toggle-read-only')
  if (readOnlyItem) {
    readOnlyItem.checked = state.readOnly
    readOnlyItem.enabled = state.readOnlyToggleEnabled
  }

  for (const command of MENU_COMMAND_IDS) {
    const item = menu.getMenuItemById(menuCommandId(command))
    if (!item) continue

    item.enabled =
      !(state.readOnly && isModifyingCommand(command)) &&
      !(state.followActive && followBlockedCommands.has(command))
  }
}

function shortcutMenuProperties(
  id: ShortcutId
): Pick<MenuItemConstructorOptions, 'label' | 'accelerator' | 'registerAccelerator'> {
  const shortcut = getShortcutDefinition(id)

  return {
    label: shortcut.menuLabel ?? shortcut.label,
    accelerator: shortcut.accelerator,
    ...(shortcut.registerAccelerator === false ? { registerAccelerator: false } : {})
  }
}

function setThemePreference(theme: 'system' | 'light' | 'dark'): void {
  preferences.set('theme', theme)
  nativeTheme.themeSource = theme

  for (const browserWindow of BrowserWindow.getAllWindows()) {
    browserWindow.webContents.send('preferences:changed', { theme })
  }
}

function existingRecentFiles(): string[] {
  const storedRecentFiles = preferences.get('recentFiles')
  const seen = new Set<string>()

  const recentFiles = storedRecentFiles
    .filter((filePath) => {
      if (!existsSync(filePath) || seen.has(filePath)) return false
      seen.add(filePath)
      return true
    })
    .slice(0, maximumRecentFiles)

  if (
    recentFiles.length !== storedRecentFiles.length ||
    recentFiles.some((filePath, index) => filePath !== storedRecentFiles[index])
  ) {
    preferences.set('recentFiles', recentFiles)
  }

  return recentFiles
}

export function recordRecentFile(
  window: BrowserWindow,
  filePath: string,
  encoding: BomlessFileEncoding = 'auto'
): void {
  const recentFiles = existingRecentFiles().filter((recentPath) => recentPath !== filePath)
  preferences.set('recentFiles', [filePath, ...recentFiles].slice(0, maximumRecentFiles))
  preferences.set('lastDocumentPath', filePath)
  preferences.set('lastDocumentEncoding', encoding)
  installMenu(window)
}

export function activateMenuContextState(window: BrowserWindow): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return

  applyMenuContextState(menu, menuContextStateFor(window))

  const alwaysOnTopItem = menu.getMenuItemById('always-on-top')
  if (alwaysOnTopItem) alwaysOnTopItem.checked = window.isAlwaysOnTop()
}

export function setMenuContextState(window: BrowserWindow, state: MenuContextState): void {
  menuContextStates.set(window, { ...state })

  if (focusedDocumentWindow() !== window) return
  activateMenuContextState(window)
}

export function installMenu(window: BrowserWindow): void {
  documentWindows.add(window)
  const recentFiles = existingRecentFiles()
  const sendEditorPreferences = (): void => {
    sendToDocumentWindows('menu:editor-preferences', {
      trimTrailingWhitespaceOnSave: preferences.get('trimTrailingWhitespaceOnSave'),
      autoIndent: preferences.get('autoIndent'),
      tabSize: preferences.get('tabSize'),
      insertSpaces: preferences.get('insertSpaces'),
      largeFileWarningMiB: preferences.get('largeFileWarningMiB')
    })
  }
  const recentFileItems: MenuItemConstructorOptions[] =
    recentFiles.length > 0
      ? recentFiles.map((filePath) => ({
          label: filePath,
          click: () => sendToFocusedDocument('app:open-file-in-new-window-requested', filePath)
        }))
      : [{ label: '(Empty)', enabled: false }]

  recentFileItems.push(
    { type: 'separator' },
    {
      label: 'Clear Recent Files',
      enabled: recentFiles.length > 0,
      click: () => {
        preferences.set('recentFiles', [])
        const target = availableDocumentWindow()
        if (target) installMenu(target)
      }
    }
  )

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          ...shortcutMenuProperties('new'),
          click: () => sendToFocusedDocument('menu:command', 'new')
        },
        {
          ...shortcutMenuProperties('open'),
          click: () => sendToFocusedDocument('menu:command', 'open')
        },
        {
          label: 'Open as ANSI (Windows-1252)...',
          click: () => sendToFocusedDocument('menu:command', 'open-ansi')
        },
        {
          label: 'Recent Files',
          submenu: recentFileItems
        },
        { type: 'separator' },
        {
          label: 'Reopen With Encoding',
          submenu: [
            ['UTF-8', 'reopen-encoding:utf8'],
            ['UTF-8 BOM', 'reopen-encoding:utf8-bom'],
            ['UTF-16 LE', 'reopen-encoding:utf16le'],
            ['UTF-16 BE', 'reopen-encoding:utf16be'],
            ['ANSI (Windows-1252)', 'reopen-encoding:windows1252']
          ].map(([label, command]) => ({
            id: menuCommandId(command),
            label,
            click: () => sendToFocusedDocument('menu:command', command)
          }))
        },
        {
          ...shortcutMenuProperties('reload'),
          id: menuCommandId('reload'),
          click: () => sendToFocusedDocument('menu:command', 'reload')
        },
        {
          label: 'Revert to Saved',
          id: menuCommandId('revert'),
          click: () => sendToFocusedDocument('menu:command', 'revert')
        },
        { type: 'separator' },
        {
          ...shortcutMenuProperties('save'),
          id: menuCommandId('save'),
          click: () => sendToFocusedDocument('menu:command', 'save')
        },
        {
          ...shortcutMenuProperties('save-as'),
          id: menuCommandId('save-as'),
          click: () => sendToFocusedDocument('menu:command', 'save-as')
        },
        {
          label: 'Save a Copy...',
          click: () => sendToFocusedDocument('menu:command', 'save-copy')
        },
        {
          ...shortcutMenuProperties('print'),
          click: () => sendToFocusedDocument('menu:command', 'print')
        },
        { type: 'separator' },
        {
          label: 'File Utilities',
          submenu: [
            ['Copy Full Path', 'copy-full-path'],
            ['Copy Filename', 'copy-filename'],
            ['Reveal in File Manager', 'reveal-file'],
            ['Open Terminal Here', 'open-terminal'],
            ['Document Inspector...', 'document-inspector'],
            ['SHA-256', 'sha256']
          ].map(([label, command]) => ({
            id: menuCommandId(command),
            label,
            click: () => sendToFocusedDocument('menu:command', command)
          }))
        },
        { type: 'separator' },
        {
          label: 'Reopen Last Document',
          type: 'checkbox',
          checked: preferences.get('reopenLastDocument'),
          click: (item) => preferences.set('reopenLastDocument', item.checked)
        },
        { type: 'separator' },
        {
          label: 'Exit',
          click: () => focusedDocumentWindow()?.close()
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          ...shortcutMenuProperties('undo'),
          click: () => sendToFocusedDocument('menu:command', 'undo')
        },
        {
          ...shortcutMenuProperties('redo'),
          click: () => sendToFocusedDocument('menu:command', 'redo')
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        {
          label: 'Delete',
          id: menuCommandId('delete'),
          click: () => sendToFocusedDocument('menu:command', 'delete')
        },
        { type: 'separator' },
        {
          label: 'Line',
          submenu: [
            ['Select Current Line', 'select-line'],
            ['Duplicate Line', 'duplicate-line'],
            ['Move Line Up', 'move-line-up'],
            ['Move Line Down', 'move-line-down'],
            ['Sort Lines Ascending', 'sort-lines-asc'],
            ['Sort Lines Descending', 'sort-lines-desc'],
            ['Natural Sort Ascending', 'sort-lines-natural-asc'],
            ['Natural Sort Descending', 'sort-lines-natural-desc'],
            ['Numeric Sort Ascending', 'sort-lines-numeric-asc'],
            ['Numeric Sort Descending', 'sort-lines-numeric-desc'],
            ['Reverse Lines', 'reverse-lines'],
            ['Join Lines', 'join-lines'],
            ['Split at Commas', 'split-lines-commas'],
            ['Remove Duplicate Lines', 'remove-duplicate-lines'],
            ['Delete Empty Lines', 'delete-empty-lines']
          ].map(([label, command]) => ({
            id: menuCommandId(command),
            label,
            click: () => sendToFocusedDocument('menu:command', command)
          }))
        },
        {
          label: 'Indentation',
          submenu: [
            ['Indent Selection', 'indent'],
            ['Outdent Selection', 'outdent'],
            ['Convert Tabs to Spaces', 'tabs-to-spaces'],
            ['Convert Spaces to Tabs', 'spaces-to-tabs']
          ].map(([label, command]) => ({
            id: menuCommandId(command),
            label,
            click: () => sendToFocusedDocument('menu:command', command)
          }))
        },
        {
          label: 'Convert Case',
          submenu: [
            ['UPPERCASE', 'case-upper'],
            ['lowercase', 'case-lower'],
            ['Title Case', 'case-title']
          ].map(([label, command]) => ({
            id: menuCommandId(command),
            label,
            click: () => sendToFocusedDocument('menu:command', command)
          }))
        },
        {
          label: 'Transform',
          submenu: [
            {
              label: 'Format JSON',
              id: menuCommandId('transform:format-json'),
              click: () => sendToFocusedDocument('menu:command', 'transform:format-json')
            },
            {
              label: 'Minify JSON',
              id: menuCommandId('transform:minify-json'),
              click: () => sendToFocusedDocument('menu:command', 'transform:minify-json')
            },
            {
              label: 'Format XML',
              id: menuCommandId('transform:format-xml'),
              click: () => sendToFocusedDocument('menu:command', 'transform:format-xml')
            },
            { type: 'separator' },
            ...[
              ['Base64 Encode', 'transform:base64-encode'],
              ['Base64 Decode', 'transform:base64-decode'],
              ['URL Encode', 'transform:url-encode'],
              ['URL Decode', 'transform:url-decode'],
              ['Hex Encode', 'transform:hex-encode'],
              ['Hex Decode', 'transform:hex-decode']
            ].map(([label, command]) => ({
              id: menuCommandId(command),
              label,
              click: () => sendToFocusedDocument('menu:command', command)
            })),
            { type: 'separator' },
            {
              label: 'Reflow Selection',
              submenu: [
                ['72 Columns', 'transform:reflow-72'],
                ['80 Columns', 'transform:reflow-80']
              ].map(([label, command]) => ({
                id: menuCommandId(command),
                label,
                click: () => sendToFocusedDocument('menu:command', command)
              }))
            },
            {
              label: 'Normalize Unicode',
              submenu: [
                ['NFC', 'transform:normalize-nfc'],
                ['NFD', 'transform:normalize-nfd'],
                ['NFKC', 'transform:normalize-nfkc'],
                ['NFKD', 'transform:normalize-nfkd']
              ].map(([label, command]) => ({
                id: menuCommandId(command),
                label,
                click: () => sendToFocusedDocument('menu:command', command)
              }))
            },
            { type: 'separator' },
            {
              label: 'Compute Selection Hash',
              submenu: [
                ['SHA-256 (Copy)', 'hash:sha256'],
                ['SHA-1 (Legacy Checksum - Copy)', 'hash:sha1'],
                ['MD5 (Legacy Checksum - Copy)', 'hash:md5']
              ].map(([label, command]) => ({
                id: menuCommandId(command),
                label,
                click: () => sendToFocusedDocument('menu:command', command)
              }))
            }
          ]
        },
        {
          label: 'Trim Trailing Whitespace',
          id: menuCommandId('trim-trailing-whitespace'),
          click: () => sendToFocusedDocument('menu:command', 'trim-trailing-whitespace')
        },
        {
          ...shortcutMenuProperties('toggle-line-comment'),
          id: menuCommandId('toggle-line-comment'),
          click: () => sendToFocusedDocument('menu:command', 'toggle-line-comment')
        },
        {
          ...shortcutMenuProperties('matching-bracket'),
          click: () => sendToFocusedDocument('menu:command', 'matching-bracket')
        },
        { type: 'separator' },
        {
          ...shortcutMenuProperties('filter-lines'),
          click: () => sendToFocusedDocument('menu:command', 'filter-lines')
        },
        {
          label: 'Regex Extract...',
          click: () => sendToFocusedDocument('menu:command', 'regex-extract')
        },
        {
          ...shortcutMenuProperties('find'),
          click: () => sendToFocusedDocument('menu:command', 'find')
        },
        {
          ...shortcutMenuProperties('find-next'),
          click: () => sendToFocusedDocument('menu:command', 'find-next')
        },
        {
          ...shortcutMenuProperties('find-previous'),
          click: () => sendToFocusedDocument('menu:command', 'find-previous')
        },
        {
          ...shortcutMenuProperties('replace'),
          click: () => sendToFocusedDocument('menu:command', 'replace')
        },
        {
          ...shortcutMenuProperties('go-to'),
          click: () => sendToFocusedDocument('menu:command', 'go-to')
        },
        { type: 'separator' },
        {
          label: 'Bookmarks',
          submenu: [
            {
              ...shortcutMenuProperties('bookmark-toggle'),
              id: menuCommandId('bookmark-toggle'),
              click: () => sendToFocusedDocument('menu:command', 'bookmark-toggle')
            },
            {
              ...shortcutMenuProperties('bookmark-next'),
              click: () => sendToFocusedDocument('menu:command', 'bookmark-next')
            },
            {
              ...shortcutMenuProperties('bookmark-previous'),
              click: () => sendToFocusedDocument('menu:command', 'bookmark-previous')
            },
            {
              label: 'Clear All Bookmarks',
              id: menuCommandId('bookmark-clear'),
              click: () => sendToFocusedDocument('menu:command', 'bookmark-clear')
            }
          ]
        },
        { type: 'separator' },
        {
          ...shortcutMenuProperties('select-all'),
          click: () => sendToFocusedDocument('menu:command', 'select-all')
        },
        {
          ...shortcutMenuProperties('time-date'),
          id: menuCommandId('time-date'),
          click: () => sendToFocusedDocument('menu:command', 'time-date')
        },
        { type: 'separator' },
        {
          id: 'toggle-read-only',
          ...shortcutMenuProperties('toggle-read-only'),
          type: 'checkbox',
          checked: false,
          click: () => sendToFocusedDocument('menu:command', 'toggle-read-only')
        },
        { type: 'separator' },
        {
          ...shortcutMenuProperties('preferences'),
          click: () => sendToFocusedDocument('menu:command', 'preferences')
        }
      ]
    },
    {
      label: 'Format',
      submenu: [
        {
          label: 'Word Wrap',
          type: 'checkbox',
          checked: preferences.get('wordWrap'),
          click: (item) => {
            preferences.set('wordWrap', item.checked)
            sendToDocumentWindows('menu:word-wrap', item.checked)
          }
        },
        {
          label: 'Tab Width',
          submenu: ([2, 4, 8] as const).map((size) => ({
            label: String(size),
            type: 'radio' as const,
            checked: preferences.get('tabSize') === size,
            click: () => {
              preferences.set('tabSize', size)
              sendEditorPreferences()
            }
          }))
        },
        {
          label: 'Indentation Style',
          submenu: [
            {
              label: 'Insert Spaces',
              type: 'radio' as const,
              checked: preferences.get('insertSpaces'),
              click: () => {
                preferences.set('insertSpaces', true)
                sendEditorPreferences()
              }
            },
            {
              label: 'Insert Literal Tabs',
              type: 'radio' as const,
              checked: !preferences.get('insertSpaces'),
              click: () => {
                preferences.set('insertSpaces', false)
                sendEditorPreferences()
              }
            }
          ]
        },
        {
          label: 'Auto Indent',
          submenu: [
            {
              label: 'Plain',
              type: 'radio' as const,
              checked: preferences.get('autoIndent') === 'none',
              click: () => {
                preferences.set('autoIndent', 'none')
                sendEditorPreferences()
              }
            },
            {
              label: 'Basic Auto Indent',
              type: 'radio' as const,
              checked: preferences.get('autoIndent') === 'full',
              click: () => {
                preferences.set('autoIndent', 'full')
                sendEditorPreferences()
              }
            }
          ]
        },
        {
          label: 'Trim Trailing Whitespace on Save',
          type: 'checkbox',
          checked: preferences.get('trimTrailingWhitespaceOnSave'),
          click: (item) => {
            preferences.set('trimTrailingWhitespaceOnSave', item.checked)
            sendEditorPreferences()
          }
        },
        { type: 'separator' },
        {
          label: 'Language',
          submenu: [
            ['Auto Detect', 'language:auto'],
            ['Plain Text', 'language:plaintext'],
            ['Markdown', 'language:markdown'],
            ['JSON', 'language:json'],
            ['JavaScript', 'language:javascript'],
            ['TypeScript', 'language:typescript'],
            ['Python', 'language:python'],
            ['Shell', 'language:shell'],
            ['HTML', 'language:html'],
            ['CSS', 'language:css'],
            ['C / C++', 'language:cpp']
          ].map(([label, command]) => ({
            id: menuCommandId(command),
            label,
            click: () => sendToFocusedDocument('menu:command', command)
          }))
        },
        {
          label: 'Encoding',
          submenu: [
            ['UTF-8', 'encoding:utf8'],
            ['UTF-8 BOM', 'encoding:utf8-bom'],
            ['UTF-16 LE', 'encoding:utf16le'],
            ['UTF-16 BE', 'encoding:utf16be'],
            ['ANSI (Windows-1252)', 'encoding:windows1252']
          ].map(([label, command]) => ({
            id: menuCommandId(command),
            label,
            click: () => sendToFocusedDocument('menu:command', command)
          }))
        },
        {
          label: 'Line Endings',
          submenu: [
            {
              label: 'Normalize to LF',
              click: () => sendToFocusedDocument('menu:command', 'eol:LF')
            },
            {
              label: 'Normalize to CRLF',
              click: () => sendToFocusedDocument('menu:command', 'eol:CRLF')
            }
          ]
        },
        {
          label: 'Final Newline',
          submenu: [
            {
              label: 'Add Final Newline',
              id: menuCommandId('add-final-newline'),
              click: () => sendToFocusedDocument('menu:command', 'add-final-newline')
            },
            {
              label: 'Remove Final Newline',
              id: menuCommandId('remove-final-newline'),
              click: () => sendToFocusedDocument('menu:command', 'remove-final-newline')
            }
          ]
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'follow-file',
          label: 'Follow File',
          type: 'checkbox',
          checked: false,
          enabled: false,
          click: () => sendToFocusedDocument('menu:command', 'follow-file')
        },
        {
          label: 'Typewriter Scrolling',
          type: 'checkbox',
          checked: preferences.get('typewriterScrolling'),
          click: (item) => {
            preferences.set('typewriterScrolling', item.checked)
            sendToDocumentWindows('menu:typewriter-scrolling', item.checked)
          }
        },
        { type: 'separator' },
        {
          label: 'Appearance',
          submenu: [
            {
              label: 'Status Bar',
              type: 'checkbox',
              checked: preferences.get('statusBarVisible'),
              click: (item) => {
                preferences.set('statusBarVisible', item.checked)
                sendToDocumentWindows('menu:status-bar', item.checked)
              }
            },
            { type: 'separator' },
            {
              label: 'System',
              type: 'radio',
              checked: preferences.get('theme') === 'system',
              click: () => setThemePreference('system')
            },
            {
              label: 'Light',
              type: 'radio',
              checked: preferences.get('theme') === 'light',
              click: () => setThemePreference('light')
            },
            {
              label: 'Dark',
              type: 'radio',
              checked: preferences.get('theme') === 'dark',
              click: () => setThemePreference('dark')
            }
          ]
        },
        {
          ...shortcutMenuProperties('show-line-numbers'),
          type: 'checkbox',
          // Keep Ctrl+Shift+L reserved for Monaco's multicursor Select All Occurrences action.
          checked: preferences.get('showLineNumbers'),
          click: (item) => {
            preferences.set('showLineNumbers', item.checked)
            sendToDocumentWindows('menu:show-line-numbers', item.checked)
          }
        },
        {
          label: 'Show Whitespace',
          type: 'checkbox',
          checked: preferences.get('showWhitespace'),
          click: (item) => {
            preferences.set('showWhitespace', item.checked)
            sendToDocumentWindows('menu:show-whitespace', item.checked)
          }
        },
        { type: 'separator' },
        {
          label: 'Always on Top',
          type: 'checkbox',
          id: 'always-on-top',
          checked: window.isAlwaysOnTop(),
          click: (item) => {
            const target = focusedDocumentWindow()
            if (!target) return
            target.setAlwaysOnTop(item.checked)
          }
        },
        {
          label: 'Large File Warning',
          submenu: ([10, 20, 50, 100] as const).map((size) => ({
            label: `${size} MiB`,
            type: 'radio' as const,
            checked: preferences.get('largeFileWarningMiB') === size,
            click: () => {
              preferences.set('largeFileWarningMiB', size)
              sendEditorPreferences()
            }
          }))
        },
        {
          ...shortcutMenuProperties('full-screen'),
          click: () => {
            const target = focusedDocumentWindow()
            if (!target) return
            const enabled = !target.isFullScreen()
            target.setFullScreen(enabled)
            target.setMenuBarVisibility(!enabled)
            target.webContents.send('window:full-screen', enabled)
          }
        },
        { type: 'separator' },
        {
          ...shortcutMenuProperties('zoom-in'),
          click: () => sendToFocusedDocument('menu:command', 'zoom-in')
        },
        {
          ...shortcutMenuProperties('zoom-out'),
          click: () => sendToFocusedDocument('menu:command', 'zoom-out')
        },
        {
          ...shortcutMenuProperties('zoom-reset'),
          click: () => sendToFocusedDocument('menu:command', 'zoom-reset')
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: () => sendToFocusedDocument('menu:command', 'show-keyboard-shortcuts')
        },
        { type: 'separator' },
        {
          label: 'About Monaco Notepad',
          click: () => {
            const owner = availableDocumentWindow()
            if (!owner) return
            void dialog.showMessageBox(owner, {
              type: 'info',
              title: 'About Monaco Notepad',
              message: 'Monaco Notepad',
              detail: `Version ${app.getVersion()}\nA minimal desktop Notepad powered by Monaco Editor.`,
              buttons: ['OK']
            })
          }
        }
      ]
    }
  ])

  applyMenuContextState(menu, menuContextStateFor(window))
  Menu.setApplicationMenu(menu)
}
