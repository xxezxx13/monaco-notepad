import type * as monaco from 'monaco-editor'

export interface FileEolInfo {
  kind: 'LF' | 'CRLF' | 'CR' | 'Mixed'
  counts: {
    crlf: number
    lf: number
    cr: number
  }
}

export interface DocumentState {
  filePath: string | null
  encoding: 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'windows1252'
  savedEncoding: 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'windows1252'
  eol: 'LF' | 'CRLF'
  sourceEol: FileEolInfo | null
  eolNormalizationTarget: 'LF' | 'CRLF' | null
  savedVersionId: number
  readOnly: boolean
  voluntaryReadOnly: boolean
  forcedReadOnly: boolean
  protectedPath: string | null
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
    sourceEol: null,
    eolNormalizationTarget: null,
    savedVersionId: model.getAlternativeVersionId(),
    readOnly: false,
    voluntaryReadOnly: false,
    forcedReadOnly: false,
    protectedPath: null,
    fileSize: null,
    languageOverride: null,
    largeFileMode: false
  }
}

export function isDocumentDirty(model: monaco.editor.ITextModel, state: DocumentState): boolean {
  const sourceNeedsNormalization =
    state.sourceEol?.kind === 'CR' || state.sourceEol?.kind === 'Mixed'

  return (
    model.getAlternativeVersionId() !== state.savedVersionId ||
    state.encoding !== state.savedEncoding ||
    (sourceNeedsNormalization && state.eolNormalizationTarget !== null)
  )
}
