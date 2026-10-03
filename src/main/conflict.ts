import { resolve } from 'node:path'
import { statSync } from 'node:fs'

export type ConflictChoice = 'reload' | 'overwrite' | 'save-as' | 'cancel'
export type ExternalFileChangeKind = 'modified' | 'replaced' | 'deleted'

export interface SaveBaselineTracker {
  record(filePath: string | null): void
  recordSignature(filePath: string, signature: string): void
  check(filePath: string): boolean
  currentPath(): string | null
}

function signatureIdentity(signature: string | null): string | null {
  if (signature === null) return null
  const [device, inode] = signature.split(':')
  return device !== undefined && inode !== undefined ? `${device}:${inode}` : signature
}

export function classifyFileChange(
  previousSignature: string | null,
  currentSignature: string | null
): ExternalFileChangeKind {
  if (currentSignature === null) return 'deleted'
  if (previousSignature === null) return 'replaced'
  return signatureIdentity(previousSignature) === signatureIdentity(currentSignature)
    ? 'modified'
    : 'replaced'
}

export function fileSignature(filePath: string): string | null {
  try {
    const stats = statSync(filePath)
    return stats.isFile() ? `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.size}` : null
  } catch {
    return null
  }
}

export function createSaveBaselineTracker(): SaveBaselineTracker {
  let baselinePath: string | null = null
  let baselineSignature: string | null = null

  return {
    record(filePath: string | null): void {
      baselinePath = filePath ? resolve(filePath) : null
      baselineSignature = filePath ? fileSignature(filePath) : null
    },
    recordSignature(filePath: string, signature: string): void {
      baselinePath = resolve(filePath)
      baselineSignature = signature
    },
    check(filePath: string): boolean {
      if (resolve(filePath) !== baselinePath) return false
      const current = fileSignature(filePath)
      return current !== baselineSignature
    },
    currentPath(): string | null {
      return baselinePath
    }
  }
}
