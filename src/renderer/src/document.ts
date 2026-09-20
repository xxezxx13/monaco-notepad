import type * as monaco from 'monaco-editor'

export interface DocumentState {
  filePath: string | null
  encoding: 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'windows1252'
  savedEncoding: 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'windows1252'
  eol: 'LF' | 'CRLF'
  savedVersionId: number
  readOnly: boolean
  voluntaryReadOnly: boolean
  fileSize: number | null
  languageOverride: string | null
  largeFileMode: boolean
}

export function createDocumentState(model: monaco.editor.ITextModel): DocumentState {
  return {
    filePath: null,
    encoding: 'utf8',
    savedEncoding: 'utf8',
    eol: 'LF',
    savedVersionId: model.getAlternativeVersionId(),
    readOnly: false,
    voluntaryReadOnly: false,
    fileSize: null,
    languageOverride: null,
    largeFileMode: false
  }
}

export function isDocumentDirty(model: monaco.editor.ITextModel, state: DocumentState): boolean {
  return (
    model.getAlternativeVersionId() !== state.savedVersionId ||
    state.encoding !== state.savedEncoding
  )
}
