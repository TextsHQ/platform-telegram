import path from 'path'
import { texts } from '@textshq/platform-sdk'

export const BINARIES_DIR_PATH = path.join(texts.constants.BUILD_DIR_PATH, 'platform-telegram')

export const MUTED_FOREVER_CONSTANT = 10 * 365 * 86400 // 10 years in seconds
