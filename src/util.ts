import { promises as fs } from 'fs'
import { Api } from 'telegram'

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

export function toJSON(json: Api.TypeJSONValue): any {
  if (json instanceof Api.JsonNull) return undefined
  if (json instanceof Api.JsonString
    || json instanceof Api.JsonBool
    || json instanceof Api.JsonNumber) return json.value
  if (json instanceof Api.JsonArray) return json.value.map(toJSON)
  const ret: any = {}
  json.value.forEach(item => {
    ret[item.key] = toJSON(item.value)
  })
  return ret
}
