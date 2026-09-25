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

function editorLineParts(text: string): {
  lines: string[]
  eol: '\n' | '\r\n'
  hasFinalEol: boolean
} {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const hasFinalEol = text.endsWith(eol)
  const body = hasFinalEol ? text.slice(0, -eol.length) : text
  return {
    lines: body.length === 0 ? [''] : body.split(eol),
    eol,
    hasFinalEol
  }
}

function joinEditorLineParts(lines: string[], eol: '\n' | '\r\n', hasFinalEol: boolean): string {
  return lines.join(eol) + (hasFinalEol ? eol : '')
}

function naturalCompare(left: string, right: string): number {
  const leftParts = left.toLowerCase().match(/\d+|\D+/g) ?? ['']
  const rightParts = right.toLowerCase().match(/\d+|\D+/g) ?? ['']
  const count = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < count; index++) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]

    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1

    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)

    if (leftNumeric && rightNumeric) {
      const leftSignificant = leftPart.replace(/^0+(?=\d)/, '')
      const rightSignificant = rightPart.replace(/^0+(?=\d)/, '')

      if (leftSignificant.length !== rightSignificant.length) {
        return leftSignificant.length - rightSignificant.length
      }

      if (leftSignificant !== rightSignificant) {
        return leftSignificant < rightSignificant ? -1 : 1
      }

      if (leftPart.length !== rightPart.length) {
        return leftPart.length - rightPart.length
      }

      continue
    }

    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }

  return 0
}

export function naturalSortLines(text: string, descending = false): string {
  const { lines, eol, hasFinalEol } = editorLineParts(text)

  const sorted = lines
    .map((line, index) => ({ line, index }))
    .sort((left, right) => {
      const compared = naturalCompare(left.line, right.line)
      if (compared === 0) return left.index - right.index
      return descending ? -compared : compared
    })
    .map(({ line }) => line)

  return joinEditorLineParts(sorted, eol, hasFinalEol)
}

const decimalLine = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

export function numericSortLines(text: string, descending = false): string {
  if (text.length === 0) return text

  const { lines, eol, hasFinalEol } = editorLineParts(text)

  const parsed = lines.map((line, index) => {
    const value = line.trim()

    if (!decimalLine.test(value)) {
      throw new Error(
        `Numeric sort requires one finite decimal number per line (line ${index + 1})`
      )
    }

    const numeric = Number(value)

    if (!Number.isFinite(numeric)) {
      throw new Error(
        `Numeric sort requires one finite decimal number per line (line ${index + 1})`
      )
    }

    return { line, index, numeric }
  })

  parsed.sort((left, right) => {
    const compared = left.numeric - right.numeric
    if (compared === 0) return left.index - right.index
    return descending ? -compared : compared
  })

  return joinEditorLineParts(
    parsed.map(({ line }) => line),
    eol,
    hasFinalEol
  )
}

export function reverseLines(text: string): string {
  const { lines, eol, hasFinalEol } = editorLineParts(text)
  return joinEditorLineParts([...lines].reverse(), eol, hasFinalEol)
}

export function joinLines(text: string): string {
  const { lines, eol, hasFinalEol } = editorLineParts(text)

  if (lines.length <= 1) return text

  const joined = lines
    .map((line, index) => (index === 0 ? line.replace(/[\t ]+$/, '') : line.trim()))
    .join(' ')

  return joined + (hasFinalEol ? eol : '')
}

export function splitLinesAtCommas(text: string, eol: '\n' | '\r\n' = '\n'): string {
  if (!text.includes(',')) return text
  return text
    .split(',')
    .map((part) => part.trim())
    .join(eol)
}

export function reflowParagraphs(text: string, width: number, eol: '\n' | '\r\n' = '\n'): string {
  if (!Number.isInteger(width) || width < 10 || width > 1000) {
    throw new Error('Reflow width must be an integer from 10 to 1000 columns')
  }

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let paragraph: string[] = []

  const flush = (): void => {
    if (!paragraph.length) return

    const indentation = paragraph[0].match(/^[\t ]*/)?.[0] ?? ''
    const words =
      paragraph
        .map((line) => line.trim())
        .join(' ')
        .match(/\S+/g) ?? []

    if (!words.length) {
      paragraph = []
      return
    }

    let current = indentation + words[0]

    for (const word of words.slice(1)) {
      const candidate = `${current} ${word}`

      if (candidate.length <= width) {
        current = candidate
      } else {
        output.push(current)
        current = indentation + word
      }
    }

    output.push(current)
    paragraph = []
  }

  for (const line of lines) {
    if (/^[\t ]*$/.test(line)) {
      flush()
      output.push('')
    } else {
      paragraph.push(line)
    }
  }

  flush()
  return output.join(eol)
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
