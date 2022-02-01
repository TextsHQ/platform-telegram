import { promises as fs } from 'fs'
import path from 'path'
import url from 'url'
import { ASSETS_DIR } from './constants'

export const fileExists = (filePath: string) =>
  fs.access(filePath).then(() => true).catch(() => false)

export const saveAsset = async (buffer: Buffer, filename: string) => {
  const filePath = path.join(ASSETS_DIR, filename)
  await fs.writeFile(filePath, buffer)
  return filePath
}

export const getAssetPath = async (id: string | number) => {
  const filePath = path.join(ASSETS_DIR, id.toString())
  return await fileExists(filePath) ? url.pathToFileURL(filePath).href : undefined
}

export const initAssets = async () => { if (!await fileExists(ASSETS_DIR)) await fs.mkdir(ASSETS_DIR) }

const getCircularReplacer = () => {
  const seen = new WeakSet()
  return (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return
      }
      seen.add(value)
    }
    return value
  }
}

export const stringifyCircular = (value: any, space?: number) => JSON.stringify(value, getCircularReplacer, space)
