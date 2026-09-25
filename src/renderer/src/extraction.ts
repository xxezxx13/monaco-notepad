export interface RegexExtractionOptions {
  pattern: string
  caseSensitive: boolean
  captureGroup: number
}

export interface RegexExtractionResult {
  values: string[]
  matchCount: number
  text: string
}

function extractionExpression(pattern: string, caseSensitive: boolean): RegExp {
  if (pattern.length === 0) {
    throw new Error('Enter a regular expression')
  }

  try {
    return new RegExp(pattern, caseSensitive ? 'g' : 'gi')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid regular expression: ${detail}`)
  }
}

export function extractRegex(
  text: string,
  options: RegexExtractionOptions,
  eol: '\n' | '\r\n' = '\n'
): RegexExtractionResult {
  if (!Number.isInteger(options.captureGroup) || options.captureGroup < 0) {
    throw new Error('Capture group must be a non-negative integer')
  }

  const expression = extractionExpression(options.pattern, options.caseSensitive)
  const values: string[] = []

  let match: RegExpExecArray | null

  while ((match = expression.exec(text)) !== null) {
    if (options.captureGroup >= match.length) {
      throw new Error(`Capture group ${options.captureGroup} does not exist`)
    }

    values.push(match[options.captureGroup] ?? '')

    // Global JavaScript regexes do not advance automatically after an
    // empty match. Move one UTF-16 code unit so extraction always terminates.
    if (match[0].length === 0) {
      expression.lastIndex++
    }
  }

  return {
    values,
    matchCount: values.length,
    text: values.join(eol)
  }
}
