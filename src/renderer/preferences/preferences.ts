import type { AppApi } from '../../preload/index'

declare global {
  interface Window {
    api: AppApi
  }
}

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null

function getValue(element: HTMLInputElement | HTMLSelectElement): string | boolean {
  if (element instanceof HTMLInputElement && element.type === 'checkbox') return element.checked
  return element.value
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: unknown): void {
  if (element instanceof HTMLInputElement && element.type === 'checkbox') {
    element.checked = Boolean(value)
  } else {
    element.value = String(value)
  }
}

import type { Preferences } from '../../main/preferences'

function bindBoolean(id: string, key: keyof Preferences): void {
  const element = $<HTMLInputElement>(id)
  if (!element) return
  element.addEventListener('change', () => {
    void window.api.preferences.set(key, getValue(element))
  })
}

function bindText(id: string, key: keyof Preferences): void {
  const element = $<HTMLInputElement>(id)
  if (!element) return
  element.addEventListener('change', () => {
    void window.api.preferences.set(key, getValue(element))
  })
}

function bindNumber(id: string, key: keyof Preferences): void {
  const element = $<HTMLInputElement>(id)
  if (!element) return
  element.addEventListener('change', () => {
    const value = Number(getValue(element))
    void window.api.preferences.set(key, Number.isFinite(value) ? value : 0)
  })
}

function bindSelect(id: string, key: keyof Preferences): void {
  const element = $<HTMLSelectElement>(id)
  if (!element) return
  element.addEventListener('change', () => {
    void window.api.preferences.set(key, getValue(element))
  })
}

function bindRadio(name: string, key: keyof Preferences): void {
  const elements = document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)
  elements.forEach((element) => {
    element.addEventListener('change', () => {
      if (!element.checked) return
      let value: string | boolean | number = element.value
      if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (/^\d+$/.test(value)) value = Number(value)
      void window.api.preferences.set(key, value)
    })
  })
}

async function loadPreferences(): Promise<void> {
  const preferences = await window.api.preferences.getAll()

  setValue($<HTMLInputElement>('font-family')!, preferences.fontFamily)
  setValue($<HTMLInputElement>('font-size')!, String(preferences.fontSize))

  document
    .querySelectorAll<HTMLInputElement>(`input[name="tab-size"]`)
    .forEach((el) => (el.checked = String(preferences.tabSize) === el.value))

  document
    .querySelectorAll<HTMLInputElement>(`input[name="insert-spaces"]`)
    .forEach((el) => (el.checked = String(preferences.insertSpaces) === el.value))

  document
    .querySelectorAll<HTMLInputElement>(`input[name="auto-indent"]`)
    .forEach((el) => (el.checked = preferences.autoIndent === el.value))

  setValue($<HTMLInputElement>('word-wrap')!, preferences.wordWrap)
  setValue(
    $<HTMLInputElement>('trim-trailing-whitespace')!,
    preferences.trimTrailingWhitespaceOnSave
  )
  setValue($<HTMLInputElement>('show-whitespace')!, preferences.showWhitespace)
  setValue($<HTMLInputElement>('show-line-numbers')!, preferences.showLineNumbers)
  setValue($<HTMLInputElement>('primary-selection-paste')!, preferences.primarySelectionPaste)

  setValue($<HTMLInputElement>('reopen-last-document')!, preferences.reopenLastDocument)
  setValue($<HTMLSelectElement>('large-file-warning')!, String(preferences.largeFileWarningMiB))
  setValue($<HTMLSelectElement>('default-encoding')!, preferences.defaultEncoding)
  setValue($<HTMLSelectElement>('default-eol')!, preferences.defaultEol)

  setValue($<HTMLInputElement>('status-bar-visible')!, preferences.statusBarVisible)

  document
    .querySelectorAll<HTMLInputElement>(`input[name="theme"]`)
    .forEach((el) => (el.checked = preferences.theme === el.value))
}

bindText('font-family', 'fontFamily')
bindNumber('font-size', 'fontSize')
bindRadio('tab-size', 'tabSize')
bindRadio('insert-spaces', 'insertSpaces')
bindRadio('auto-indent', 'autoIndent')
bindBoolean('word-wrap', 'wordWrap')
bindBoolean('trim-trailing-whitespace', 'trimTrailingWhitespaceOnSave')
bindBoolean('show-whitespace', 'showWhitespace')
bindBoolean('show-line-numbers', 'showLineNumbers')
bindBoolean('primary-selection-paste', 'primarySelectionPaste')

bindBoolean('reopen-last-document', 'reopenLastDocument')
bindSelect('large-file-warning', 'largeFileWarningMiB')
bindSelect('default-encoding', 'defaultEncoding')
bindSelect('default-eol', 'defaultEol')

bindBoolean('status-bar-visible', 'statusBarVisible')
bindRadio('theme', 'theme')

void loadPreferences()
