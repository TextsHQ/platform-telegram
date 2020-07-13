import { Airgram, Auth, prompt, isError, toObject } from 'airgram'
import bluebird from 'bluebird'
import { PlatformAPI, OnServerEventCallback, Participant, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName } from '@textshq/platform-sdk'

import { API_ID, API_HASH } from './constants'

const IS_DEV = false

export default class Foo implements PlatformAPI {
  airgram: Airgram

  currentUser = null

  init = async () => {
    this.airgram = new Airgram({
      apiId: API_ID,
      apiHash: API_HASH,
      command: undefined,
      logVerbosityLevel: IS_DEV ? 2 : 0,
    })

    this.airgram.use(new Auth({
      code: () => prompt('Please enter the secret code:\n'),
      phoneNumber: () => prompt('Please enter your phone number:\n'),
    }))
    const me = toObject(await this.airgram.api.getMe())
    this.currentUser = me
    console.log('me', me)

    // airgram.use((ctx, next) => {
    //   if ('update' in ctx) {
    //     console.log(`[all updates][${ctx._}]`, JSON.stringify(ctx.update))
    //   }
    //   return next()
    // })
  }

  login = async (): Promise<LoginResult> => {
    await bluebird.delay(10)
    return { type: 'success' }
  }

  logout = () => { }

  dispose = () => {}

  getCurrentUser = (): CurrentUser => ({
    id: this.currentUser.id || Math.random(),
    // name: chance.name(),
    displayText: 'Telegram',
  })

  subscribeToEvents = (onEvent: OnServerEventCallback) => { }

  unsubscribeToEvents = () => {}

  serializeSession = () => { }

  searchUsers = async (typed: string) => []

  createThread = (userIDs: string[]) => null

  getThreads = async (inboxName: InboxName): Promise<Paginated<Thread>> => {
    const items = []
    return {
      items,
      hasMore: false,
      oldestCursor: null,
    }
  }

  getMessages = async (threadID: string, cursor: string): Promise<Paginated<Message>> => ({
    items: [],
    hasMore: false,
  })

  sendTextMessage = async (threadID: string, text: string) => true

  sendFileFromFilePath = async (threadID: string, filePath: string) => true

  sendFileFromBuffer = async (threadID: string, fileBuffer: Buffer, mimeType: string) => true

  sendTypingIndicator = (threadID: string) => {}

  addReaction = async (threadID: string, messageID: string, reactionName: string) => {}

  removeReaction = async (threadID: string, messageID: string, reactionName: string) => {}

  deleteMessage = async (threadID: string, messageID: string) => true

  sendReadReceipt = async (threadID: string, messageID: string) => {}
}
