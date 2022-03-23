import { promises as fs } from 'fs'
import { glob } from 'glob'

export const fileExists = (filePath: string) =>
  fs.access(filePath).then(() => true).catch(() => false)

export const fileFromWithoutExtension = (filePath: string) => {
  const g = glob.sync(filePath)
  if (g.length) return g[0]
  return filePath
}

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
