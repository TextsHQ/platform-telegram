import MTProto from '@mtproto/core'

export default class FakeAirgram {
  private mtproto: MTProto

  getMethod = (key: string) => async (params: any) => {
    console.log('[calling]', key, params)
    const res = await this.mtproto.call(key, params)
    console.log('[response]', key, params, { res })
    return { response: res }
  }

  api = new Proxy({}, {
    get: (target, key) => {
      if (typeof key !== 'string') return target[key]
      const method = new Proxy(this.getMethod(key), {
        get: (innerTarget, innerKey) => {
          if (typeof innerKey !== 'string') return innerTarget[innerKey]
          return this.getMethod(`${key}.${innerKey}`)
        },
      })
      return method
    },
  }) as any

  on = (updateName: string, callback: Function) => {
    this.mtproto.updates.on(updateName, update => {
      console.log(updateName, ':', update)
      callback(update)
    })
  }

  constructor(options: {
    apiId
    apiHash
    databaseEncryptionKey
    command
    applicationVersion
    systemVersion
    logVerbosityLevel
    useFileDatabase
    useChatInfoDatabase
    useMessageDatabase
    useSecretChats
    enableStorageOptimizer
    ignoreFileNames
    databaseDirectory
    filesDirectory
  }) {
    this.mtproto = new MTProto({
      api_id: options.apiId,
      api_hash: options.apiHash,
      storageOptions: {
        path: options.databaseDirectory + '/1.json',
      },
    })
    this.initPromise = this.init()
  }

  initPromise: ReturnType<typeof this.init>

  async init() {
    const { response } = await this.api.help.getNearestDc()
    console.log(response)
    console.log('setting default dc to', response.nearest_dc)
    this.mtproto.setDefaultDc(response.nearest_dc)
  }
}
