import type { Api } from 'telegram'
import mkdirp from 'mkdirp'
import path from 'path'
import { Airgram, isError, TDLibError, ApiResponse, BaseTdObject } from 'airgram'
import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEventType, MessageSendOptions, ActivityType, ReAuthError, OnConnStateChangeCallback, AccountInfo } from '@textshq/platform-sdk'

import { MUTED_FOREVER_CONSTANT } from './constants'
import { mapCurrentUser, mapProtoThread, mapProtoMessage, mapParticipant } from './mappers'
import TelegramAPI from './lib/telegram'
import TelegramRealTime from './lib/real-time'

type GetAssetResolveFunction = (value: string) => void
type LoginEventCallback = (authState: any) => void

function toObject<T extends BaseTdObject>({ response }: ApiResponse<any, T>): T {
  if (isError(response)) {
    switch (response.code) {
      case 401:
        throw new ReAuthError(response.message)
      default:
        throw new TDLibError(response.code, response.message)
    }
  }
  return response
}

export default class Telegram implements PlatformAPI {
  private airgram: Airgram

  private getAssetResolvers = new Map<number, GetAssetResolveFunction>()

  private fileIdToPath = new Map<number, string>()

  private loginEventCallback: LoginEventCallback

  private api: TelegramAPI = new TelegramAPI()

  private realTime: TelegramRealTime

  private currentUser: Api.TypeUserFull = null

  private loginMetadata: Record<string, any> = { state: 'authorizationStateWaitPhoneNumber' }

  private accountInfo: AccountInfo

  init = async (data: { session: string }, accountInfo: AccountInfo) => {
    this.accountInfo = accountInfo
    await mkdirp(path.join(this.accountInfo.dataDirPath, 'profile-photos'))
    await mkdirp(path.join(this.accountInfo.dataDirPath, 'temp'))
    
    const { session } = data || {}
    await this.api.init(session || '', accountInfo)
    if (session) await this.afterAuth()
  }

  getCurrentUser = () => {
    if (!this.currentUser) return null
    return mapCurrentUser(this.currentUser, this.accountInfo.dataDirPath)
  }

  // FIXME: try to find a way to serialize this
  serializeSession = () => ({ session: this.api.getSessionSerialized() })

  onLoginEvent = (onEvent: LoginEventCallback) => {
    this.loginEventCallback = onEvent
    this.loginEventCallback(this.loginMetadata.state)
  }

  onConnectionStateChange = (onEvent: OnConnStateChangeCallback) => {}

  afterAuth = async (): Promise<void> => {
    const currentUser = await this.api.getCurrentUser()
    this.currentUser = currentUser
  }

  login = async (credentials: LoginCreds = {}): Promise<LoginResult> => {
    const { phoneNumber, code, firstName, lastName, password, passwordCode } = credentials.custom
    const { state } = this.loginMetadata

    try {
      if (state === 'authorizationStateWaitPhoneNumber') {
        const nextStep = 'authorizationStateWaitCode'
        const codeHash = await this.api.getPhoneCodeHash(phoneNumber)

        this.loginEventCallback?.(nextStep)
        this.loginMetadata = { state: nextStep, codeHash }

        return { type: 'wait' }
      }

      if (state === 'authorizationStateWaitCode') {
        try {
          await this.api.login({ code, phone: phoneNumber, password: password || undefined })

          const nextStep = 'authorizationStateReady'
          this.loginEventCallback?.(nextStep)
          this.loginMetadata = { ...this.loginMetadata, state: nextStep }

          return { type: 'wait' }
        } catch (error) {
          // TODO: handle 2FA in a separated state. For now this handled this way because Telegram
          // throws an error if the user tries to login with code and then with password
          if (error.message === 'Account has 2FA enabled.') {
            return { type: 'error', errorMessage: '2FA activated, you need to include your password' }
          }

          return { type: 'error', errorMessage: 'Error.' }
        }
      }

      if (state === 'authorizationSignUp') {
        const nextStep = 'authorizationStateReady'

        await this.api.register({
          code,
          phone: phoneNumber,
          codeHash: this.loginMetadata.codeHash,
          firstName,
          lastName,
        })

        this.loginEventCallback?.(nextStep)
        this.loginMetadata = { ...this.loginMetadata, state: nextStep }

        return { type: 'wait' }
      }

      if (state === 'authorizationStateReady') {
        await this.afterAuth()
        return { type: 'success' }
      }

      // This is an unknown error
      return { type: 'error', errorMessage: 'Unknown Error' }
    } catch (error) {
      console.log(error)
      return { type: 'error', errorMessage: 'Unknown Error' }
    }
  }

  logout = async () => this.api.logout()

  dispose = async () => {}

  private onEvent: OnServerEventCallback = () => {}

  subscribeToEvents = (onEvent: OnServerEventCallback) => {
    this.onEvent = onEvent
    this.api.setOnEvent(onEvent)

    this.realTime = new TelegramRealTime(this.api, this.onEvent)
    this.realTime.subscribeToEvents()
  }

  searchUsers = async (query: string) => {
    const res = await this.api.searchContacts(query)
    const promises = res.map((user) => mapParticipant(user, this.accountInfo.dataDirPath))
    const users = await Promise.all(promises)

    return users
  }

  createThread = async (userIDs: string[], title?: string) => {
    const res = await this.api.createThread(userIDs, title)
    const [firstThread] = res
    const mappedThread = mapProtoThread(firstThread, this.accountInfo.dataDirPath)

    return mappedThread
  }

  updateThread = async (threadID: string, updates: Partial<Thread>) => {
    if ('mutedUntil' in updates) {
      await this.airgram.api.setChatNotificationSettings({
        chatId: +threadID,
        notificationSettings: {
          _: 'chatNotificationSettings',
          muteFor: updates.mutedUntil === 'forever' ? MUTED_FOREVER_CONSTANT : 0,
        },
      })
      return true
    }
  }

  deleteThread = async (threadID: string) => {
    await this.api.deleteThreadHistory(threadID)
  }

  getUser = async ({ userID }: { userID?: string; }) => {
    if (!userID) return

    const res = await this.api.getUserInfo(Number(userID))
    return mapParticipant(res.user, this.accountInfo.dataDirPath)
  }

  getThreads = async (inboxName: InboxName, pagination: PaginationArg): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    // This is added to speed up the initial load.
    if (!this.api.topPeers) {
      const topPeers = await this.api.getTopPeers()
      const oldestCursor = String(topPeers[topPeers?.length - 1]?.id) || 'peers'
      const items = topPeers.map(thread => mapProtoThread(thread, this.accountInfo.dataDirPath)) || []

      return { items, hasMore: true, oldestCursor }
    }

    const threads = await this.api.getThreads()
    const oldestCursor = String(threads[threads?.length - 1]?.id)
    const items = threads?.map(thread => mapProtoThread(thread, this.accountInfo.dataDirPath))

    return {
      oldestCursor,
      items: items || [],
      // If there was an error it'll return "null" so that means there are more threads to load
      hasMore: items === null ? true : items?.length > 0,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    const { cursor } = pagination || { cursor: null, direction: null }

    const messages = await this.api.getMessages(threadID, Number(cursor))
    const oldestCursor = String(messages[0]?.id)

    const items = messages.map(mapProtoMessage)

    return {
      items: items || [],
      oldestCursor,
      // If there was an error it'll return "null" so that means there are more messages to load
      hasMore: items === null ? true : items?.length > 0,
    }
  }

  sendMessage = async (threadID: string, msgContent: MessageContent, { quotedMessageID }: MessageSendOptions) => {
    const res = await this.api.sendMessage(threadID, msgContent, quotedMessageID)
    return res
  }

  editMessage = async (threadID: string, messageID: string, msgContent: MessageContent) => {
    const res = await this.api.editMessage(threadID, messageID, msgContent)
    return res
  }

  forwardMessage = async (threadID: string, messageID: string, threadIDs?: string[], userIDs?: string[]): Promise<boolean> => {
    const promises = await Promise.all(threadIDs.map(async toThreadID => {
      const res = await this.api.forwardMessage(threadID, messageID, toThreadID)
      return res
    }))

    return promises.every(Boolean)
  }

  sendActivityIndicator = async (type: ActivityType, threadID: string) => {
    await this.api.sendTypingIndicator(type, threadID)
  }

  deleteMessage = async (_, messageID: string, forEveryone: boolean) => {
    const res = await this.api.deleteMessage(messageID, forEveryone)
    return res
  }

  sendReadReceipt = async (threadID: string, messageID: string) => {
    const res = await this.api.sendReadReceipt(threadID, messageID)
    return res
  }

  markAsUnread = async (threadID: string) => {
    await this.api.markAsUnread(threadID)
  }

  // TODO: Archive thread
  // archiveThread = async (threadID: string, archived: boolean) => {
  //   return
  // }

  /**
   * The frontend will request twice for each fileId, the first time for the
   * wave form, the second time for the <audio> element.
   */
  getAsset = async (type: string, fileIdStr: string) => {
    if (type !== 'file') throw new Error('unknown asset type')

    const fileId = +fileIdStr
    const filePath = this.fileIdToPath.get(fileId)
    if (filePath) {
      // Download has finished, this is the second request for fileId.
      this.fileIdToPath.delete(fileId)
      return filePath
    }

    const pendingResolve = this.getAssetResolvers.get(fileId)
    return new Promise<string>(resolve => {
      if (pendingResolve) {
        // Download has not finished, this is the second request for fileId.
        this.getAssetResolvers.set(fileId, url => {
          pendingResolve(url)
          resolve(url)
        })
      } else {
        // This is the first request for fileId.
        this.airgram.api.downloadFile({ fileId, priority: 32 })
        this.getAssetResolvers.set(fileId, resolve)
      }
    })
  }

  handleDeepLink = async (link: string) => {
    const [,,,, type, chatID, messageID, data] = link.split('/')
    if (type !== 'callback') return
    const res = await this.airgram.api.getCallbackQueryAnswer({
      chatId: +chatID,
      messageId: +messageID,
      payload: {
        _: 'callbackQueryPayloadData',
        data,
      }
    })
    const answer = toObject(res)
    if (!answer.text) return
    this.onEvent([{
      type: ServerEventType.TOAST,
      toast: {
        // todo answer.url
        text: answer.text,
      },
    }])
  }
}
