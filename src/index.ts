/* eslint-disable global-require */
import { Platform, texts } from '@textshq/platform-sdk'
import path from 'path'

export default {
  get info() {
    require('module').globalPaths.unshift(path.join(texts.constants.BUILD_DIR_PATH, '../node_modules'))
    return require('./info').default
  },

  get api() {
    return require('./api').default
  },
} as Platform
