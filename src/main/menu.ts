import { app, BrowserWindow, dialog, Menu } from 'electron'
import { existsSync } from 'node:fs'
import { preferences } from './preferences'
import type { BomlessFileEncoding } from './files'

const maximumRecentFiles = 10

function existingRecentFiles(): string[] {
  const recentFiles = preferences.get('recentFiles').filter((filePath) => existsSync(filePath))

  if (recentFiles.length !== preferences.get('recentFiles').length) {
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

export function setFollowMenuState(checked: boolean, enabled: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('follow-file')
  if (!item) return
  item.checked = checked
  item.enabled = enabled
}

export function installMenu(window: BrowserWindow): void {
  const recentFiles = existingRecentFiles()
  const sendEditorPreferences = (): void => {
    window.webContents.send('menu:editor-preferences', {
      trimTrailingWhitespaceOnSave: preferences.get('trimTrailingWhitespaceOnSave'),
      autoIndent: preferences.get('autoIndent'),
      tabSize: preferences.get('tabSize'),
      insertSpaces: preferences.get('insertSpaces'),
      largeFileWarningMiB: preferences.get('largeFileWarningMiB')
    })
  }
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => window.webContents.send('menu:command', 'new')
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: () => window.webContents.send('menu:command', 'open')
        },
        {
          label: 'Open as ANSI (Windows-1252)...',
          click: () => window.webContents.send('menu:command', 'open-ansi')
        },
        {
          label: 'Recent Files',
          submenu:
            recentFiles.length > 0
              ? recentFiles.map((filePath) => ({
                  label: filePath,
                  click: () => window.webContents.send('app:open-file-requested', filePath)
                }))
              : [{ label: '(Empty)', enabled: false }]
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
            label,
            click: () => window.webContents.send('menu:command', command)
          }))
        },
        {
          label: 'Reload from Disk',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => window.webContents.send('menu:command', 'reload')
        },
        {
          label: 'Revert to Saved',
          click: () => window.webContents.send('menu:command', 'revert')
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => window.webContents.send('menu:command', 'save')
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => window.webContents.send('menu:command', 'save-as')
        },
        {
          label: 'Save a Copy...',
          click: () => window.webContents.send('menu:command', 'save-copy')
        },
        {
          label: 'Print...',
          accelerator: 'CmdOrCtrl+P',
          click: () => window.webContents.send('menu:command', 'print')
        },
        { type: 'separator' },
        {
          label: 'File Utilities',
          submenu: [
            ['Copy Full Path', 'copy-full-path'],
            ['Copy Filename', 'copy-filename'],
            ['Reveal in File Manager', 'reveal-file'],
            ['Open Terminal Here', 'open-terminal'],
            ['File Properties', 'file-properties'],
            ['SHA-256', 'sha256']
          ].map(([label, command]) => ({
            label,
            click: () => window.webContents.send('menu:command', command)
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
          click: () => window.close()
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => window.webContents.send('menu:command', 'undo')
        },
        {
          label: 'Redo',
          accelerator: 'Ctrl+Y',
          click: () => window.webContents.send('menu:command', 'redo')
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        {
          label: 'Delete',
          click: () => window.webContents.send('menu:command', 'delete')
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
            ['Remove Duplicate Lines', 'remove-duplicate-lines'],
            ['Delete Empty Lines', 'delete-empty-lines']
          ].map(([label, command]) => ({
            label,
            click: () => window.webContents.send('menu:command', command)
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
            label,
            click: () => window.webContents.send('menu:command', command)
          }))
        },
        {
          label: 'Convert Case',
          submenu: [
            ['UPPERCASE', 'case-upper'],
            ['lowercase', 'case-lower'],
            ['Title Case', 'case-title']
          ].map(([label, command]) => ({
            label,
            click: () => window.webContents.send('menu:command', command)
          }))
        },
        {
          label: 'Transform',
          submenu: [
            {
              label: 'Format JSON',
              click: () => window.webContents.send('menu:command', 'transform:format-json')
            },
            {
              label: 'Minify JSON',
              click: () => window.webContents.send('menu:command', 'transform:minify-json')
            },
            {
              label: 'Format XML',
              click: () => window.webContents.send('menu:command', 'transform:format-xml')
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
              label,
              click: () => window.webContents.send('menu:command', command)
            })),
            { type: 'separator' },
            {
              label: 'Compute Selection Hash',
              submenu: [
                ['SHA-256 (Copy)', 'hash:sha256'],
                ['SHA-1 (Legacy Checksum - Copy)', 'hash:sha1'],
                ['MD5 (Legacy Checksum - Copy)', 'hash:md5']
              ].map(([label, command]) => ({
                label,
                click: () => window.webContents.send('menu:command', command)
              }))
            }
          ]
        },
        {
          label: 'Trim Trailing Whitespace',
          click: () => window.webContents.send('menu:command', 'trim-trailing-whitespace')
        },
        {
          label: 'Toggle Line Comment',
          accelerator: 'CmdOrCtrl+/',
          registerAccelerator: false,
          click: () => window.webContents.send('menu:command', 'toggle-line-comment')
        },
        {
          label: 'Go to Matching Bracket',
          accelerator: 'CmdOrCtrl+Shift+\\',
          registerAccelerator: false,
          click: () => window.webContents.send('menu:command', 'matching-bracket')
        },
        { type: 'separator' },
        {
          label: 'Find...',
          accelerator: 'CmdOrCtrl+F',
          click: () => window.webContents.send('menu:command', 'find')
        },
        {
          label: 'Find Next',
          accelerator: 'F3',
          click: () => window.webContents.send('menu:command', 'find-next')
        },
        {
          label: 'Replace...',
          accelerator: 'CmdOrCtrl+H',
          click: () => window.webContents.send('menu:command', 'replace')
        },
        {
          label: 'Go To...',
          accelerator: 'CmdOrCtrl+G',
          click: () => window.webContents.send('menu:command', 'go-to')
        },
        { type: 'separator' },
        {
          label: 'Bookmarks',
          submenu: [
            {
              label: 'Toggle Bookmark',
              accelerator: 'Ctrl+Shift+F2',
              click: () => window.webContents.send('menu:command', 'bookmark-toggle')
            },
            {
              label: 'Next Bookmark',
              accelerator: 'F2',
              click: () => window.webContents.send('menu:command', 'bookmark-next')
            },
            {
              label: 'Previous Bookmark',
              accelerator: 'Shift+F2',
              click: () => window.webContents.send('menu:command', 'bookmark-previous')
            },
            {
              label: 'Clear All Bookmarks',
              click: () => window.webContents.send('menu:command', 'bookmark-clear')
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          click: () => window.webContents.send('menu:command', 'select-all')
        },
        {
          label: 'Time/Date',
          accelerator: 'F5',
          click: () => window.webContents.send('menu:command', 'time-date')
        },
        { type: 'separator' },
        {
          label: 'Read Only',
          type: 'checkbox',
          accelerator: 'Ctrl+Shift+L',
          checked: false,
          click: () => window.webContents.send('menu:command', 'toggle-read-only')
        },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => window.webContents.send('menu:command', 'preferences')
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
            window.webContents.send('menu:word-wrap', item.checked)
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
            label,
            click: () => window.webContents.send('menu:command', command)
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
            label,
            click: () => window.webContents.send('menu:command', command)
          }))
        },
        {
          label: 'Line Endings',
          submenu: [
            {
              label: 'Normalize to LF',
              click: () => window.webContents.send('menu:command', 'eol:LF')
            },
            {
              label: 'Normalize to CRLF',
              click: () => window.webContents.send('menu:command', 'eol:CRLF')
            }
          ]
        },
        {
          label: 'Final Newline',
          submenu: [
            {
              label: 'Add Final Newline',
              click: () => window.webContents.send('menu:command', 'add-final-newline')
            },
            {
              label: 'Remove Final Newline',
              click: () => window.webContents.send('menu:command', 'remove-final-newline')
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
          click: () => window.webContents.send('menu:command', 'follow-file')
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
                window.webContents.send('menu:status-bar', item.checked)
              }
            },
            { type: 'separator' },
            {
              label: 'System',
              type: 'radio',
              checked: preferences.get('theme') === 'system',
              click: () => {
                preferences.set('theme', 'system')
                window.webContents.send('preferences:changed', { theme: 'system' })
              }
            },
            {
              label: 'Light',
              type: 'radio',
              checked: preferences.get('theme') === 'light',
              click: () => {
                preferences.set('theme', 'light')
                window.webContents.send('preferences:changed', { theme: 'light' })
              }
            },
            {
              label: 'Dark',
              type: 'radio',
              checked: preferences.get('theme') === 'dark',
              click: () => {
                preferences.set('theme', 'dark')
                window.webContents.send('preferences:changed', { theme: 'dark' })
              }
            }
          ]
        },
        {
          label: 'Show Line Numbers',
          type: 'checkbox',
          // Ctrl+Shift+L selects all occurrences in Monaco's multicursor feature.
          accelerator: 'Ctrl+Shift+F9',
          checked: preferences.get('showLineNumbers'),
          click: (item) => {
            preferences.set('showLineNumbers', item.checked)
            window.webContents.send('menu:show-line-numbers', item.checked)
          }
        },
        {
          label: 'Show Whitespace',
          type: 'checkbox',
          checked: preferences.get('showWhitespace'),
          click: (item) => {
            preferences.set('showWhitespace', item.checked)
            window.webContents.send('menu:show-whitespace', item.checked)
          }
        },
        { type: 'separator' },
        {
          label: 'Always on Top',
          type: 'checkbox',
          checked: window.isAlwaysOnTop(),
          click: (item) => window.setAlwaysOnTop(item.checked)
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
          label: 'Full Screen',
          accelerator: 'F11',
          click: () => {
            const enabled = !window.isFullScreen()
            window.setFullScreen(enabled)
            window.setMenuBarVisibility(!enabled)
            window.webContents.send('window:full-screen', enabled)
          }
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          registerAccelerator: false,
          click: () => window.webContents.send('menu:command', 'zoom-in')
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          registerAccelerator: false,
          click: () => window.webContents.send('menu:command', 'zoom-out')
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          registerAccelerator: false,
          click: () => window.webContents.send('menu:command', 'zoom-reset')
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Monaco Notepad',
          click: () => {
            void dialog.showMessageBox(window, {
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

  Menu.setApplicationMenu(menu)
}
