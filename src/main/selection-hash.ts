import { createHash } from 'node:crypto'

export type SelectionHashAlgorithm = 'sha256' | 'sha1' | 'md5'

export function selectionDigests(
  algorithm: SelectionHashAlgorithm,
  selections: readonly string[]
): string[] {
  if (!['sha256', 'sha1', 'md5'].includes(algorithm)) throw new Error('Unsupported hash algorithm')
  if (!selections.length || selections.some((selection) => selection.length === 0)) {
    throw new Error('Select text to hash')
  }
  return selections.map((selection) =>
    createHash(algorithm).update(selection, 'utf8').digest('hex')
  )
}
