import type { Platform } from '@textshq/platform-sdk'
import indexedDB from 'fake-indexeddb'
import IDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange'
import Worker from 'web-worker';
global.Worker = Worker
// @ts-expect-error
global.window = global
global.indexedDB = indexedDB
global.IDBKeyRange = IDBKeyRange

export default {
  get info() {
    return require('./info').default
  },

  get api() {
    return require('./api').default
  },
} as Platform
