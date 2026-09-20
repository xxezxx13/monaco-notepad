import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import iconv from 'iconv-lite'
import type { FileEncoding } from './files'

export type FollowReason = 'truncated' | 'rotated' | 'recreated'
export type FollowUpdate =
  | { kind: 'append'; text: string; from: number; to: number }
  | { kind: 'reset'; text: string; reason: FollowReason; from: 0; to: number }
  | { kind: 'waiting' }

function identity(stats: Awaited<ReturnType<typeof stat>>): string {
  return `${stats.dev}:${stats.ino}`
}

class FollowDecoder {
  private decoder: StringDecoder
  private oddByte = Buffer.alloc(0)
  private pendingHighSurrogate = ''
  private atStart: boolean

  constructor(
    private readonly encoding: FileEncoding,
    atStart = true
  ) {
    this.decoder = new StringDecoder(this.nodeEncoding())
    this.atStart = atStart
  }

  private nodeEncoding(): BufferEncoding {
    if (this.encoding === 'utf16le' || this.encoding === 'utf16be') return 'utf16le'
    return 'utf8'
  }

  reset(): void {
    this.decoder = new StringDecoder(this.nodeEncoding())
    this.oddByte = Buffer.alloc(0)
    this.pendingHighSurrogate = ''
    this.atStart = true
  }

  decode(bytes: Uint8Array): string {
    let text: string
    if (this.encoding === 'windows1252') {
      text = iconv.decode(Buffer.from(bytes), 'windows-1252')
    } else if (this.encoding === 'utf16le' || this.encoding === 'utf16be') {
      const combined = Buffer.concat([this.oddByte, Buffer.from(bytes)])
      const completeLength = combined.length - (combined.length % 2)
      this.oddByte = combined.subarray(completeLength)
      let decoded = ''
      for (let offset = 0; offset < completeLength; offset += 2) {
        const codeUnit =
          this.encoding === 'utf16be'
            ? (combined[offset] << 8) | combined[offset + 1]
            : combined[offset] | (combined[offset + 1] << 8)
        decoded += String.fromCharCode(codeUnit)
      }
      text = this.pendingHighSurrogate + decoded
      this.pendingHighSurrogate = ''
      const last = text.charCodeAt(text.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) {
        this.pendingHighSurrogate = text.at(-1) ?? ''
        text = text.slice(0, -1)
      }
    } else {
      text = this.decoder.write(Buffer.from(bytes))
    }

    if (this.atStart && text) {
      this.atStart = false
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    }
    return text
  }
}

async function readRange(filePath: string, from: number, to: number): Promise<Uint8Array> {
  const length = to - from
  if (length <= 0) return new Uint8Array()
  const handle = await open(filePath, 'r')
  try {
    const bytes = Buffer.allocUnsafe(length)
    let consumed = 0
    while (consumed < length) {
      const result = await handle.read(bytes, consumed, length - consumed, from + consumed)
      if (result.bytesRead === 0) break
      consumed += result.bytesRead
    }
    return bytes.subarray(0, consumed)
  } finally {
    await handle.close()
  }
}

export class FollowReader {
  private offset: number
  private fileIdentity: string | null
  private readonly decoder: FollowDecoder

  private constructor(
    readonly filePath: string,
    encoding: FileEncoding,
    size: number,
    fileIdentity: string
  ) {
    this.offset = size
    this.fileIdentity = fileIdentity
    // The current editor already contains the bytes before this offset. Only a
    // stream starting at byte zero may contain a BOM that should be stripped.
    this.decoder = new FollowDecoder(encoding, size === 0)
  }

  static async create(filePath: string, encoding: FileEncoding): Promise<FollowReader> {
    const stats = await stat(filePath)
    if (!stats.isFile()) throw new Error('Follow File supports regular files only')
    return new FollowReader(filePath, encoding, stats.size, identity(stats))
  }

  get consumedBytes(): number {
    return this.offset
  }

  async poll(): Promise<FollowUpdate[]> {
    let stats: Awaited<ReturnType<typeof stat>>
    try {
      stats = await stat(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (this.fileIdentity !== null) {
        this.fileIdentity = null
        this.offset = 0
        this.decoder.reset()
        return [{ kind: 'waiting' }]
      }
      return []
    }
    if (!stats.isFile()) throw new Error('Followed path is no longer a regular file')

    const nextIdentity = identity(stats)
    const reason: FollowReason | null =
      this.fileIdentity === null
        ? 'recreated'
        : nextIdentity !== this.fileIdentity
          ? 'rotated'
          : stats.size < this.offset
            ? 'truncated'
            : null

    if (reason) {
      this.decoder.reset()
      const bytes = await readRange(this.filePath, 0, stats.size)
      this.offset = bytes.length
      this.fileIdentity = nextIdentity
      return [
        {
          kind: 'reset',
          text: this.decoder.decode(bytes),
          reason,
          from: 0,
          to: this.offset
        }
      ]
    }

    if (stats.size <= this.offset) return []
    const from = this.offset
    const bytes = await readRange(this.filePath, from, stats.size)
    this.offset = from + bytes.length
    return [{ kind: 'append', text: this.decoder.decode(bytes), from, to: this.offset }]
  }
}
