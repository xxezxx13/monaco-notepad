// Counts Unicode code points, including spaces and the document's actual LF/CRLF
// characters. Combining marks count separately; this is not a glyph count.
export function countCharacters(text: string): number {
  let count = 0
  for (let offset = 0; offset < text.length; count++) {
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1
  }
  return count
}

export function countWords(text: string): number {
  let count = 0
  const words = /\S+/gu
  while (words.exec(text)) count++
  return count
}

export function convertCase(text: string, mode: 'upper' | 'lower' | 'title'): string {
  if (mode === 'upper') return text.toUpperCase()
  if (mode === 'lower') return text.toLowerCase()

  // Deterministic, language-independent title case: lowercase each whitespace-
  // separated word, then uppercase its first Unicode letter.
  return text
    .toLowerCase()
    .replace(/\S+/gu, (word) => word.replace(/\p{L}/u, (letter) => letter.toUpperCase()))
}

export function trimTrailingWhitespace(text: string): string {
  return text.replace(/[\t ]+(?=\r?$)/gm, '')
}

export function tabsToSpaces(text: string, tabSize: number): string {
  return text
    .split(/(\r?\n)/)
    .map((part, index) => {
      if (index % 2) return part
      const indentation = part.match(/^[\t ]*/)?.[0] ?? ''
      let column = 0
      let converted = ''
      for (const character of indentation) {
        if (character === '\t') {
          const count = tabSize - (column % tabSize)
          converted += ' '.repeat(count)
          column += count
        } else {
          converted += character
          column++
        }
      }
      return converted + part.slice(indentation.length).replace(/\t/g, ' '.repeat(tabSize))
    })
    .join('')
}

export function indentationSpacesToTabs(text: string, tabSize: number): string {
  return text.replace(/^[ ]+/gm, (spaces) => {
    const tabs = Math.floor(spaces.length / tabSize)
    return '\t'.repeat(tabs) + ' '.repeat(spaces.length % tabSize)
  })
}

export function sortLines(text: string, descending = false): string {
  const lines = text.split('\n')
  lines.sort((left, right) => {
    const normalizedLeft = left.toLowerCase()
    const normalizedRight = right.toLowerCase()
    const result = normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0
    return descending ? -result : result
  })
  return lines.join('\n')
}

export function removeDuplicateLines(text: string): string {
  const seen = new Set<string>()
  return text
    .split('\n')
    .filter((line) => (seen.has(line) ? false : (seen.add(line), true)))
    .join('\n')
}

export function deleteEmptyLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^[\t ]*$/.test(line))
    .join('\n')
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
