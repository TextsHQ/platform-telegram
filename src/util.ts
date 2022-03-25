import { promises as fs } from 'fs'
import type { EntityLike } from 'telegram/define'
import { getPeerId } from 'telegram/Utils'

export const fileExists = (filePath: string) =>
  fs.access(filePath).then(() => true).catch(() => false)

const getCircularReplacer = () => {
  const seen = new WeakSet()
  return (key: string, value: any) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return
      }
      seen.add(value)
    }
    return value
  }
}

export const stringifyCircular = (value: any, space?: number) => JSON.stringify(value, getCircularReplacer(), space)

export const getPeerIdUnmarked = (peer: EntityLike) => getPeerId(peer, false)
