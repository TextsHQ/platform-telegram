import path from 'path'
import { SupportedReaction, texts } from '@textshq/platform-sdk'

export const BINARIES_DIR_PATH = path.join(texts.constants.BUILD_DIR_PATH, 'platform-telegram')

export const API_ID = 1216419

export const API_HASH = '7353efc824823e14ad31cd2b05272466'

export const MUTED_FOREVER_CONSTANT = 10 * 365 * 86400 // 10 years in seconds

export const REACTIONS: Record<string, SupportedReaction> = {
  thumbsUp: { title: 'Thumbs Up', render: '👍' },
  thumbsDown: { title: 'Thumbs Down', render: '👎' },
  heart: { title: 'Red Heart', render: '❤️' },
  fire: { title: 'Fire', render: '🔥' },
  smilingHearts: { title: 'Smiling Face with Hearts', render: '🥰' },
  partyPopper: { title: 'Party Popper', render: '🎉' },
  starStruckt: { title: 'Star-Struck', render: '🤩' },
  screaming: { title: 'Screaming Face', render: '😱' },
  beaming: { title: 'Beaming Face', render: '😁' },
  thinking: { title: 'Thinking Face', render: '🤔' },
  explodingHead: { title: 'Exploding Head', render: '🤯' },
  crying: { title: 'Crying Face', render: '😢' },
  faceSwearing: { title: 'Face with Symbols on Mouth', render: '🤬' },
  poo: { title: 'Pile of Poo', render: '💩' },
  vomiting: { title: 'Face Vomiting', render: '🤮' },
}

const dylibPath = {
  darwin: `${process.platform}-${process.arch}/libtdjson.dylib`,
  linux: `${process.platform}-${process.arch}/libtdjson.so`,
  win32: `${process.platform}-${process.arch}/libtdjson.dll`,
}[process.platform]

export const tdlibPath = dylibPath ? path.join(BINARIES_DIR_PATH, dylibPath) : undefined
