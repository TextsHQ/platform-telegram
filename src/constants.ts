import path from 'path'
import { texts } from '@textshq/platform-sdk'

export const BINARIES_DIR_PATH = path.join(texts.constants.BUILD_DIR_PATH, 'platform-telegram')

export const API_ID = 1216419

export const API_HASH = '7353efc824823e14ad31cd2b05272466'

export const MUTED_FOREVER_CONSTANT = 2147483647 // max int32

const dylibPath = {
  darwin: `${process.platform}-${process.arch}/libtdjson.dylib`,
  linux: `${process.platform}-${process.arch}/libtdjson.so`,
  win32: `${process.platform}-${process.arch}/libtdjson.dll`,
}[process.platform]

export const tdlibPath = dylibPath ? path.join(BINARIES_DIR_PATH, dylibPath) : undefined
