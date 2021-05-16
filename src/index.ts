import type { Platform } from '@textshq/platform-sdk'
import Worker from 'web-worker';
global.Worker = Worker

export default {
  get info() {
    return require('./info').default
  },

  get api() {
    return require('./api').default
  },
} as Platform
