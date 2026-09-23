export type LineFilterMode = 'literal' | 'regex'

export interface LineFilterOptions {
  query: string
  mode: LineFilterMode
  caseSensitive: boolean
  invert: boolean
}

export interface FilteredLine {
  lineNumber: number
  text: string
  occurrences: number
}

export interface LineFilterResult {
  active: boolean
  error: string | null
  matchCount: number
  matchingLineCount: number
  selectedLineCount: number
  sourceLineCount: number
  lines: FilteredLine[]
}

type LineMatcher = (line: string) => number

function countLiteralMatches(line: string, query: string, caseSensitive: boolean): number {
  const source = caseSensitive ? line : line.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()

  let count = 0
  let offset = 0

  while (offset <= source.length - needle.length) {
    const index = source.indexOf(needle, offset)
    if (index === -1) break

    count++
    offset = index + needle.length
  }

  return count
}

function countRegexMatches(line: string, expression: RegExp): number {
  expression.lastIndex = 0

  let count = 0
  let match: RegExpExecArray | null

  while ((match = expression.exec(line)) !== null) {
    count++

    // JavaScript global regexes can otherwise repeat forever on a
    // zero-length match at the same position.
    if (match[0].length === 0) {
      expression.lastIndex++
    }
  }

  return count
}

function compileMatcher(options: LineFilterOptions): {
  matcher: LineMatcher | null
  error: string | null
} {
  if (options.query.length === 0) {
    return { matcher: null, error: null }
  }

  if (options.mode === 'literal') {
    return {
      matcher: (line) => countLiteralMatches(line, options.query, options.caseSensitive),
      error: null
    }
  }

  try {
    const expression = new RegExp(options.query, options.caseSensitive ? 'g' : 'gi')

    return {
      matcher: (line) => countRegexMatches(line, expression),
      error: null
    }
  } catch (error) {
    return {
      matcher: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function visitLogicalLines(
  text: string,
  visitor: (line: string, lineNumber: number) => void
): void {
  let start = 0
  let lineNumber = 1

  for (let index = 0; index < text.length; index++) {
    const character = text[index]

    if (character === '\r') {
      visitor(text.slice(start, index), lineNumber++)

      if (text[index + 1] === '\n') {
        index++
      }

      start = index + 1
    } else if (character === '\n') {
      visitor(text.slice(start, index), lineNumber++)
      start = index + 1
    }
  }

  // A final unterminated line is still a real source line. A trailing
  // line ending does not create an additional empty grep record.
  if (start < text.length) {
    visitor(text.slice(start), lineNumber)
  }
}

export function scanLineFilter(text: string, options: LineFilterOptions): LineFilterResult {
  const compiled = compileMatcher(options)

  if (compiled.error) {
    return {
      active: true,
      error: compiled.error,
      matchCount: 0,
      matchingLineCount: 0,
      selectedLineCount: 0,
      sourceLineCount: 0,
      lines: []
    }
  }

  if (!compiled.matcher) {
    return {
      active: false,
      error: null,
      matchCount: 0,
      matchingLineCount: 0,
      selectedLineCount: 0,
      sourceLineCount: 0,
      lines: []
    }
  }

  const lines: FilteredLine[] = []
  let matchCount = 0
  let matchingLineCount = 0
  let sourceLineCount = 0

  visitLogicalLines(text, (line, lineNumber) => {
    sourceLineCount++

    const occurrences = compiled.matcher!(line)
    const matches = occurrences > 0

    matchCount += occurrences
    if (matches) matchingLineCount++

    if (options.invert ? !matches : matches) {
      lines.push({
        lineNumber,
        text: line,
        occurrences
      })
    }
  })

  return {
    active: true,
    error: null,
    matchCount,
    matchingLineCount,
    selectedLineCount: lines.length,
    sourceLineCount,
    lines
  }
}

export function replaceLineFilterTail(
  previous: LineFilterResult,
  oldTailText: string,
  newTailText: string,
  startLineNumber: number,
  options: LineFilterOptions
): LineFilterResult {
  if (!Number.isInteger(startLineNumber) || startLineNumber < 1) {
    throw new Error('Invalid filter tail start line')
  }

  if (!previous.active || previous.error) {
    return previous
  }

  const oldTail = scanLineFilter(oldTailText, options)
  const newTail = scanLineFilter(newTailText, options)

  if (!oldTail.active || oldTail.error || !newTail.active || newTail.error) {
    throw new Error('Filter options changed during incremental update')
  }

  const prefix = previous.lines.filter((line) => line.lineNumber < startLineNumber)

  const replacement = newTail.lines.map((line) => ({
    ...line,
    lineNumber: line.lineNumber + startLineNumber - 1
  }))

  const lines = [...prefix, ...replacement]

  return {
    active: true,
    error: null,
    matchCount: previous.matchCount - oldTail.matchCount + newTail.matchCount,
    matchingLineCount:
      previous.matchingLineCount - oldTail.matchingLineCount + newTail.matchingLineCount,
    selectedLineCount: lines.length,
    sourceLineCount: previous.sourceLineCount - oldTail.sourceLineCount + newTail.sourceLineCount,
    lines
  }
}
