export type TextTransform = (text: string) => string

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Decoded bytes are not valid UTF-8')
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function formatJson(text: string, indentation: string | number): string {
  return JSON.stringify(JSON.parse(text), null, indentation)
}

export function minifyJson(text: string): string {
  return JSON.stringify(JSON.parse(text))
}

export function encodeBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

export function decodeBase64(text: string): string {
  const normalized = text.trim()
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    throw new Error('Invalid Base64')
  }
  const binary = atob(normalized)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytesToBase64(bytes) !== normalized) throw new Error('Invalid Base64')
  return decodeUtf8(bytes)
}

export function encodeUrl(text: string): string {
  return encodeURIComponent(text)
}

export function decodeUrl(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    throw new Error('Invalid URL encoding')
  }
}

export function encodeHex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

export function decodeHex(text: string): string {
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) {
    throw new Error('Invalid hexadecimal input')
  }
  const bytes = new Uint8Array(text.length / 2)
  for (let index = 0; index < text.length; index += 2) {
    bytes[index / 2] = Number.parseInt(text.slice(index, index + 2), 16)
  }
  return decodeUtf8(bytes)
}

type XmlNode =
  | { type: 'text'; raw: string }
  | { type: 'raw'; raw: string }
  | {
      type: 'element'
      name: string
      open: string
      close: string
      selfClosing: boolean
      children: XmlNode[]
    }

function xmlTokens(text: string): string[] {
  const tokens: string[] = []
  let offset = 0
  while (offset < text.length) {
    const opening = text.indexOf('<', offset)
    if (opening < 0) {
      tokens.push(text.slice(offset))
      break
    }
    if (opening > offset) tokens.push(text.slice(offset, opening))

    const rest = text.slice(opening)
    const specialEnd = rest.startsWith('<!--')
      ? '-->'
      : rest.startsWith('<![CDATA[')
        ? ']]>'
        : rest.startsWith('<?')
          ? '?>'
          : null
    if (specialEnd) {
      const end = text.indexOf(specialEnd, opening + 2)
      if (end < 0) throw new Error('Invalid XML: unterminated markup')
      const next = end + specialEnd.length
      tokens.push(text.slice(opening, next))
      offset = next
      continue
    }
    if (/^<!DOCTYPE\b/i.test(rest)) {
      throw new Error('Invalid XML: DTD declarations are not supported')
    }

    let quote: string | null = null
    let end = opening + 1
    for (; end < text.length; end++) {
      const character = text[end]
      if (quote) {
        if (character === quote) quote = null
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        break
      }
    }
    if (end >= text.length || quote) throw new Error('Invalid XML: unterminated tag')
    tokens.push(text.slice(opening, end + 1))
    offset = end + 1
  }
  return tokens
}

function parseXml(text: string): XmlNode[] {
  const roots: XmlNode[] = []
  const stack: Array<Extract<XmlNode, { type: 'element' }>> = []
  const append = (node: XmlNode): void => {
    const parent = stack.at(-1)
    ;(parent ? parent.children : roots).push(node)
  }

  for (const token of xmlTokens(text)) {
    if (!token.startsWith('<')) {
      append({ type: 'text', raw: token })
      continue
    }
    if (token.startsWith('<!--') || token.startsWith('<![CDATA[') || token.startsWith('<?')) {
      append({ type: 'raw', raw: token })
      continue
    }
    const closing = /^<\/\s*([A-Za-z_][\w:.-]*)\s*>$/.exec(token)
    if (closing) {
      const element = stack.pop()
      if (!element || element.name !== closing[1]) {
        throw new Error(`Invalid XML: unexpected closing tag ${closing[1]}`)
      }
      element.close = token
      continue
    }
    const opening = /^<\s*([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?\s*\/?>$/.exec(token)
    if (!opening) throw new Error('Invalid XML: malformed tag')
    const tagBody = token
      .slice(token.indexOf(opening[1]) + opening[1].length, token.length - 1)
      .replace(/\/\s*$/, '')
    let attributes = tagBody
    const names = new Set<string>()
    while (attributes.trim()) {
      const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"[^"]*"|'[^']*')/.exec(attributes)
      if (!attribute) throw new Error('Invalid XML: malformed attribute')
      if (names.has(attribute[1]))
        throw new Error(`Invalid XML: duplicate attribute ${attribute[1]}`)
      names.add(attribute[1])
      attributes = attributes.slice(attribute[0].length)
    }
    const selfClosing = /\/\s*>$/.test(token)
    const element: Extract<XmlNode, { type: 'element' }> = {
      type: 'element',
      name: opening[1],
      open: token,
      close: '',
      selfClosing,
      children: []
    }
    append(element)
    if (!selfClosing) stack.push(element)
  }
  if (stack.length) throw new Error(`Invalid XML: unclosed tag ${stack.at(-1)?.name}`)
  const elements = roots.filter((node) => node.type === 'element')
  if (elements.length !== 1) throw new Error('Invalid XML: expected one root element')
  if (roots.some((node) => node.type === 'text' && node.raw.trim())) {
    throw new Error('Invalid XML: text outside the root element')
  }
  return roots
}

function inlineXml(node: XmlNode): string {
  if (node.type !== 'element') return node.raw
  if (node.selfClosing) return node.open
  return node.open + node.children.map(inlineXml).join('') + node.close
}

function renderXml(node: XmlNode, depth: number, indentation: string): string {
  const prefix = indentation.repeat(depth)
  if (node.type !== 'element') return prefix + node.raw.trim()
  if (node.selfClosing) return prefix + node.open

  const meaningfulText = node.children.some(
    (child) => child.type === 'text' && child.raw.trim().length > 0
  )
  if (meaningfulText) return prefix + inlineXml(node)

  const children = node.children.filter(
    (child) => child.type !== 'text' || child.raw.trim().length > 0
  )
  if (!children.length) return prefix + node.open + node.close
  return `${prefix}${node.open}\n${children
    .map((child) => renderXml(child, depth + 1, indentation))
    .join('\n')}\n${prefix}${node.close}`
}

export function formatXml(text: string, indentation: string): string {
  return parseXml(text)
    .filter((node) => node.type !== 'text' || node.raw.trim())
    .map((node) => renderXml(node, 0, indentation))
    .join('\n')
}
