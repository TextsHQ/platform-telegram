import { promises as fs } from 'fs'

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
