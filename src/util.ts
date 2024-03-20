import BigInteger from 'big-integer'
import { promises as fs } from 'fs'
import { Api } from 'telegram'
import { parseID, resolveId } from 'telegram/Utils'

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

/**
 * Based on `buildInputPeer` from the official Telegram Web A client:
 * https://github.com/Ajaxy/telegram-tt/blob/21c4484d7a7bc24b06526ed55b11bc1aefbef5cc/src/api/gramjs/gramjsBuilders/index.ts#L76
 */
export function createInputPeer(id: string, accessHash?: string) {
  const [peerId, type] = resolveId(parseID(id))

  // We're not using instanceof here because the type of `type` is:
  // typeof Api.PeerUser | typeof Api.PeerChannel | typeof Api.PeerChat
  if (type === Api.PeerUser) {
    return new Api.InputPeerUser({
      userId: peerId,
      accessHash: BigInteger(accessHash!),
    })
  }

  if (type === Api.PeerChannel) {
    return new Api.InputPeerChannel({
      channelId: peerId,
      accessHash: BigInteger(accessHash!),
    })
  }

  return new Api.InputPeerChat({
    chatId: peerId,
  })
}
