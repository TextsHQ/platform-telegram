/* eslint-disable @typescript-eslint/no-throw-literal */
import { randomBytes } from 'crypto'
import path from 'path'
import { promises as fsp } from 'fs'
import url from 'url'
import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, MessageSendOptions, ActivityType, ReAuthError, StateSyncEvent, Participant, AccountInfo, User } from '@textshq/platform-sdk'
import { debounce } from 'lodash'
import BigInteger from 'big-integer'
import bluebird from 'bluebird'
import { TelegramClient } from 'telegram'
import { NewMessage, NewMessageEvent } from 'telegram/events'
import { Api } from 'telegram/tl'
import { CustomFile } from 'telegram/client/uploads'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { CustomMessage } from 'telegram/tl/custom/message'
import type { SendMessageParams } from 'telegram/client/messages'
import { API_ID, API_HASH, MUTED_FOREVER_CONSTANT, tdlibPath } from './constants'
import { REACTIONS, AuthState } from './common-constants'
import TelegramMapper from './mappers'
import { fileExists, getPeerIdUnmarked } from './util'
import { DbSession } from './dbSession'
import type { AirgramMigration, AirgramSession } from './AirgramMigration'

type LoginEventCallback = (authState: AuthState) => void

const { IS_DEV } = texts

if (IS_DEV) {
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  require('source-map-support').install()
}

async function getMessageContent(msgContent: MessageContent) {
  const { fileBuffer, fileName, filePath } = msgContent
  const buffer = filePath ? await fsp.readFile(filePath) : fileBuffer
  return buffer && new CustomFile(fileName, buffer.byteLength, filePath, buffer)
}
interface LoginInfo {
  phoneNumber?: string
  phoneCodeHash?: string
  phoneCode?: string
  password?: string
}

const isAirgramSession = (session: string | AirgramSession): session is AirgramSession =>
  !!(session as AirgramSession)?.dbKey

export default class TelegramAPI implements PlatformAPI {
  private client: TelegramClient

  private authState: AuthState

  private accountInfo: AccountInfo

  private loginEventCallback: LoginEventCallback

  private dbSession: DbSession

  private dialogs: Map<string, Dialog> = new Map<string, Dialog>()

  private messageMediaStore = new Map<number, Api.TypeMessageMedia>()

  private chatIdMessageId = new Map<string, Set<number>>()

  private dialogIdToParticipantIds = new Map<string, Set<string>>()

  private me: Api.User

  private meMapped: User

  private mapper: TelegramMapper

  private sessionName: string

  private airgramMigration: AirgramMigration

  private loginInfo: LoginInfo = {}

  init = async (session: string | AirgramSession | undefined, accountInfo: AccountInfo) => {
    this.accountInfo = accountInfo

    if (isAirgramSession(session) && tdlibPath && await fileExists(tdlibPath)) {
      const { AirgramMigration } = await import('./AirgramMigration')
      this.airgramMigration = new AirgramMigration()
      this.airgramMigration.connectAirgramSession(session, accountInfo)
      session = randomBytes(8).toString('hex')
    }
    this.sessionName = session as string || randomBytes(8).toString('hex')

    const dbPath = path.join(accountInfo.dataDirPath, this.sessionName + '.sqlite')
    this.dbSession = new DbSession({ dbPath })

    await this.dbSession.init()

    this.client = new TelegramClient(this.dbSession, API_ID, API_HASH, {
      retryDelay: 5000,
      autoReconnect: true,
      connectionRetries: Infinity,
      maxConcurrentDownloads: 8,
    })

    await this.client.connect()
    if (this.airgramMigration) {
      await this.airgramMigration.migrateAirgramSession(this.accountInfo.dataDirPath, this.client, this.dbSession)
      this.onEvent([
        {
          type: ServerEventType.SESSION_UPDATED,
        },
        {
          type: ServerEventType.TOAST,
          toast: {
            text: "Telegram integration has been rebuilt for speed. Your login session was auto-migrated and you'll see a new login notification.",
          },
        },
      ])
    }

    this.authState = AuthState.PHONE_INPUT

    if (session) await this.afterLogin()
  }

  onLoginEvent = (onEvent: LoginEventCallback) => {
    this.loginEventCallback = onEvent
    this.loginEventCallback(this.authState)
  }

  getUser = async (ids: { userID?: string } | { username?: string } | { phoneNumber?: string } | { email?: string }) => {
    const user = await (async () => {
      if ('userID' in ids) { return this.client.getEntity(ids.userID) }
      if ('username' in ids) { return this.client.getEntity(ids.username) }
      if ('phoneNumber' in ids) { return this.client.getEntity(ids.phoneNumber) }
      if ('email' in ids) { return this.client.getEntity(ids.email) }
    })()
    if (user instanceof Api.User) return this.mapper.mapUser(user)
  }

  login = async (creds: LoginCreds = {}): Promise<LoginResult> => {
    const mapError = (message: string) => {
      if (message === 'PASSWORD_HASH_INVALID') return 'Password is invalid.'
      if (message === 'PHONE_CODE_INVALID') return 'Code is invalid.'
      if (message === 'PHONE_NUMBER_INVALID') return 'Phone number is invalid.'
      return message
    }

    texts.log('CREDS_CUSTOM', JSON.stringify(creds.custom, null, 4))
    try {
      switch (this.authState) {
        case AuthState.PHONE_INPUT:
        {
          this.loginInfo.phoneNumber = creds.custom.phoneNumber
          const res = await this.client.invoke(new Api.auth.SendCode({
            apiHash: API_HASH,
            apiId: API_ID,
            phoneNumber: this.loginInfo.phoneNumber,
            settings: new Api.CodeSettings({
              allowFlashcall: true,
              currentNumber: true,
              allowAppHash: true,
            }),
          }))
          texts.log('PHONE_INPUT', JSON.stringify(res))
          this.loginInfo.phoneCodeHash = res.phoneCodeHash
          this.authState = AuthState.CODE_INPUT
          break
        }
        case AuthState.CODE_INPUT:
        {
          this.loginInfo.phoneCode = creds.custom.code
          if (this.loginInfo.phoneNumber === undefined || this.loginInfo.phoneCodeHash === undefined || this.loginInfo.phoneCode === undefined) throw new ReAuthError(JSON.stringify(this.loginInfo, null, 4))
          const res = await this.client.invoke(new Api.auth.SignIn({
            phoneNumber: this.loginInfo.phoneNumber,
            phoneCodeHash: this.loginInfo.phoneCodeHash,
            phoneCode: this.loginInfo.phoneCode,
          }))
          texts.log('CODE_INPUT', JSON.stringify(res))
          this.authState = AuthState.READY
          break
        }
        case AuthState.PASSWORD_INPUT:
        {
          this.loginInfo.password = creds.custom.password
          await this.client.signInWithPassword({
            apiHash: API_HASH,
            apiId: API_ID,
          }, {
            password: async () => this.loginInfo.password ?? '',
            onError: async err => { texts.log(`Auth error ${err}`); return true },
          })
          this.authState = AuthState.READY
          break
        }
        case AuthState.READY:
        {
          texts.log('READY')
          this.dbSession.save()
          await this.afterLogin()
          return { type: 'success' }
        }
        default:
        {
          texts.log(`Auth state is ${this.authState}`)
          return { type: 'error' }
        }
      }
    } catch (e) {
      texts.log('err', e, JSON.stringify(e, null, 4))
      texts.Sentry.captureException(e)
      if (e.code === 401) this.authState = AuthState.PASSWORD_INPUT
      else return { type: 'error', errorMessage: mapError(e.errorMessage) }
    }

    this.loginEventCallback(this.authState)
    return { type: 'wait' }
  }

  private storeMessage = (message: CustomMessage) => {
    if (message.media) {
      this.messageMediaStore.set(message.id, message.media)
    }
    if (!message.chatId) return
    const threadID = getPeerIdUnmarked(message.chatId)
    const set = this.chatIdMessageId.get(threadID)
    if (set) {
      set.add(message.id)
    } else {
      this.chatIdMessageId.set(threadID, new Set([message.id]))
    }
  }

  private emitMessage = (message: Api.Message) => {
    const threadID = getPeerIdUnmarked(message.chatId)
    const mappedMessage = this.mapper.mapMessage(message)
    if (!mappedMessage) return
    this.emitParticipantFromMessage(threadID, message.senderId)
    if (!mappedMessage) return
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'message',
      objectIDs: { threadID },
      entries: [mappedMessage],
    }
    this.storeMessage(message)
    this.onEvent([event])
  }

  private onUpdateNewMessage = async (newMessageEvent: NewMessageEvent) => {
    const { message } = newMessageEvent
    this.emitMessage(message)
  }

  private mapThread = async (dialog: Dialog) => {
    const participants = dialog.isUser
      // cloning because getParticipants returns a TotalList (a gramjs extension of Array) and TotalList doesn't deserialize correctly when sending to iOS
      ? [...await this.client.getParticipants(dialog.id, {})].map(this.mapper.mapUser)
      : []

    const thread = this.mapper.mapThread(dialog, participants)
    if (dialog.message) this.storeMessage(dialog.message)
    this.dialogs.set(thread.id, dialog)

    // has to run once thread is included
    // not best way but simplest place to put this for now
    if (participants.length === 0) setTimeout(() => this.emitParticipants(dialog), 5_000)

    return thread
  }

  private onUpdateChatChannel = async (update: Api.UpdateChat | Api.UpdateChannel | Api.UpdateChatParticipants) => {
    const id = (update instanceof Api.UpdateChat ? update.chatId
      : update instanceof Api.UpdateChannel ? update.channelId
        : update.participants.chatId).toString()
    for await (const dialog of this.client.iterDialogs({ limit: 5 })) {
      if (dialog.entity.id.toString() === id) {
        const thread = await this.mapThread(dialog)
        const event: ServerEvent = {
          type: ServerEventType.STATE_SYNC,
          mutationType: 'upsert',
          objectName: 'thread',
          objectIDs: {},
          entries: [thread],
        }
        this.onEvent([event])
      }
    }
    return false
  }

  private onUpdateChatChannelParticipant(update: Api.UpdateChatParticipant | Api.UpdateChannelParticipant) {
    const id = getPeerIdUnmarked(update instanceof Api.UpdateChatParticipant ? update.chatId : update.channelId)
    if (update.prevParticipant) {
      this.emitDeleteThread(id.toString())
    }
    if (update.newParticipant) this.emitParticipantFromMessage(id, update.userId)
  }

  private onUpdateDeleteMessages(update: Api.UpdateDeleteMessages | Api.UpdateDeleteChannelMessages | Api.UpdateDeleteScheduledMessages) {
    if (!update.messages?.length) return
    const threadID = Array.from(this.chatIdMessageId).find(chat => chat[1].has(update.messages[0]))
    if (!threadID) return
    this.onEvent([
      {
        type: ServerEventType.STATE_SYNC,
        objectIDs: {
          threadID: threadID[0].toString(),
        },
        mutationType: 'delete',
        objectName: 'message',
        entries: update.messages.map(id => id.toString()),
      },
    ])
  }

  private onUpdateReadMessagesContents = async (update: Api.UpdateReadMessagesContents | Api.UpdateChannelReadMessagesContents) => {
    const messageID = String(update.messages[0])
    const res = await this.client.getMessages(undefined, { ids: update.messages })
    const entries = this.mapper.mapMessages(res)
    if (res.length === 0) return
    const threadID = res[0].chatId?.toString()
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'update',
      objectName: 'message',
      objectIDs: { threadID, messageID },
      entries,
    }])
  }

  private registerUpdateListeners() {
    this.client.addEventHandler(this.onUpdateNewMessage, new NewMessage({}))
    this.client.addEventHandler(async (update: Api.TypeUpdate | Api.TypeUpdates) => {
      if (update instanceof Api.UpdateChat
        || update instanceof Api.UpdateChannel
        || update instanceof Api.UpdateChatParticipants) await this.onUpdateChatChannel(update)
      else if (update instanceof Api.ChatParticipant || update instanceof Api.UpdateChannelParticipant) this.onUpdateChatChannelParticipant(update)
      else if (update instanceof Api.UpdateDeleteMessages
        || update instanceof Api.UpdateDeleteChannelMessages
        || update instanceof Api.UpdateDeleteScheduledMessages) this.onUpdateDeleteMessages(update)
      else if (update instanceof Api.UpdateReadMessagesContents
        || update instanceof Api.UpdateChannelReadMessagesContents) await this.onUpdateReadMessagesContents(update)
      const events = this.mapper.mapUpdate(update)
      if (events.length) this.onEvent(events)
    })
  }

  private emitDeleteThread(threadID: string) {
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'delete',
      objectName: 'thread',
      objectIDs: {},
      entries: [threadID],
    }
    this.onEvent([event])
  }

  private emptyAssets = async () => {
    // for perfomance testing
    const mediaDir = path.join(this.accountInfo.dataDirPath, 'media')
    const photosDir = path.join(this.accountInfo.dataDirPath, 'photos')
    try {
      await fsp.rm(mediaDir, { recursive: true })
      await fsp.rm(photosDir, { recursive: true })
    } catch {
      // ignore
    }
  }

  private afterLogin = async () => {
    // await this.emptyAssets()
    await this.createAssetsDir()
    this.me = this.me || await this.client.getMe() as Api.User
    this.mapper = new TelegramMapper(this.accountInfo, this.me)
    this.meMapped = this.mapper.mapUser(this.me)
    this.registerUpdateListeners()
  }

  private pendingEvents: ServerEvent[] = []

  private onEvent: OnServerEventCallback = (events: ServerEvent[]) => {
    this.pendingEvents.push(...events)
    this.debouncedPushEvents()
  }

  private onServerEvent: OnServerEventCallback

  private debouncedPushEvents = debounce(() => {
    if (!this.onServerEvent) return
    if (!this.pendingEvents.length) return
    this.onServerEvent(this.pendingEvents)
    this.pendingEvents = []
  }, 300)

  private upsertParticipants(dialogId: string, entries: Participant[]) {
    const threadID = dialogId
    const dialogParticipants = this.dialogIdToParticipantIds.get(threadID)
    const filteredEntries = dialogParticipants ? entries.filter(e => !dialogParticipants.has(e.id)) : entries

    if (filteredEntries.length === 0) return
    this.dialogToParticipantIdsUpdate(threadID, entries.map(m => m.id))
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'participant',
      objectIDs: {
        threadID,
      },
      entries: filteredEntries,
    }])
  }

  private dialogToParticipantIdsUpdate = (dialogId: string, participantIds: string[]) => {
    const threadID = dialogId
    const dialog = this.dialogIdToParticipantIds.get(threadID)
    if (dialog) {
      participantIds.forEach(id => dialog.add(id))
    } else {
      this.dialogIdToParticipantIds.set(threadID, new Set(participantIds))
    }
  }

  private emitParticipantFromMessage = async (dialogId: string, userId: BigInteger.BigInteger) => {
    const dialogIdUnmarked = getPeerIdUnmarked(dialogId)
    const inputEntity = await this.client.getInputEntity(userId)
    if (inputEntity.className === 'InputPeerEmpty') return
    const user = await this.client.getEntity(userId)
    if (user instanceof Api.User) {
      const mappedUser = this.mapper.mapUser(user)
      this.upsertParticipants(dialogIdUnmarked, [mappedUser])
    }
  }

  private emitParticipantsFromMessageAction = async (messages: CustomMessage[]) => {
    const withUserId = messages.filter(msg => (msg.fromId && 'userId' in msg.fromId)
      || (msg.action && 'users' in msg.action))
    // @ts-expect-error
    withUserId.forEach(({ chatId, fromId }) => this.emitParticipantFromMessage(chatId, fromId.userId))
  }

  private emitParticipants = async (dialog: Dialog) => {
    if (!dialog.id) return
    const dialogId = getPeerIdUnmarked(dialog.id)
    const limit = 256
    const members = await (async () => {
      try {
        return await this.client.getParticipants(dialogId, { showTotal: true, limit })
      } catch (e) {
        // texts.log('Error emitParticipants', e)
        if (e.code === 400) {
          // only channel admins can request users
          // texts.log(`Admin required for this channel: ${dialog.name}`)
          return []
        }
        // texts.log(`emitParticipants(): ${stringifyCircular(e, 2)}`)
        return []
      }
    })()

    if (!members) return
    const mappedMembers = await Promise.all(members.map(m => this.mapper.mapUser(m)))
    this.upsertParticipants(dialogId, mappedMembers)
  }

  private getAssetPath = (assetType: 'media' | 'photos', id: string | number, extension: string) =>
    path.join(this.accountInfo.dataDirPath, assetType, `${id.toString()}.${extension}`)

  private getAssetPathWithoutExt = (assetType: 'media' | 'photos', id: string | number) =>
    path.join(this.accountInfo.dataDirPath, assetType, `${id.toString()}`)

  private createAssetsDir = async () => {
    const mediaDir = path.join(this.accountInfo.dataDirPath, 'media')
    const photosDir = path.join(this.accountInfo.dataDirPath, 'photos')

    await fsp.mkdir(mediaDir, { recursive: true })
    await fsp.mkdir(photosDir, { recursive: true })
  }

  private deleteAssetsDir = async () => {
    await fsp.rm(this.accountInfo.dataDirPath, { recursive: true })
  }

  private waitForClientConnected = async () => {
    while (!this.client.connected) {
      await bluebird.delay(50)
    }
  }

  logout = async () => {
    await this.deleteAssetsDir()
  }

  dispose = async () => {
    await this.client?.destroy()
  }

  getCurrentUser = async (): Promise<CurrentUser> => {
    const user: CurrentUser = {
      id: this.meMapped.id,
      username: this.me.username,
      fullName: this.meMapped.fullName,
      displayText: (this.me.username ? '@' + this.me.username : '') || ('+' + this.me.phone),
    }
    return user
  }

  subscribeToEvents = (onServerEvent: OnServerEventCallback) => {
    this.onServerEvent = onServerEvent
  }

  serializeSession = () => this.sessionName

  searchUsers = async (query: string) => {
    const res = await this.client.invoke(new Api.contacts.Search({ q: query }))
    const users = res.users
      .map(user => user instanceof Api.User && this.mapper.mapUser(user))
      .filter(Boolean)
    return users
  }

  createThread = async (userIDs: string[], title?: string) => {
    if (userIDs.length === 0) throw Error('userIDs empty')
    if (userIDs.length === 1) {
      // const entity = await this.client.getEntity(+userIDs[0])
      // TODO
      throw Error('not implemented')
    } else {
      if (!title) throw Error('title required')
      await this.client.invoke(new Api.messages.CreateChat({ users: userIDs, title }))
    }
    return true
  }

  updateThread = async (threadID: string, updates: Partial<Thread>) => {
    if ('mutedUntil' in updates) {
      const inputPeer = await this.client.getInputEntity(threadID)
      await this.client.invoke(new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({
          peer: inputPeer,
        }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil: updates.mutedUntil === 'forever' ? MUTED_FOREVER_CONSTANT : 0,
        }),
      }))
    }
  }

  deleteThread = async (threadID: string) => {
    this.client.invoke(new Api.messages.DeleteHistory({
      peer: threadID,
      revoke: true,
    }))
    this.client.invoke(new Api.messages.DeleteChatUser({
      userId: 'me',
      chatId: BigInteger(threadID),
      revokeHistory: true,
    }))
  }

  reportThread = async (type: 'spam', threadID: string) => {
    await this.client.invoke(new Api.account.ReportPeer({
      peer: threadID,
      reason: new Api.InputReportReasonSpam(),
    }))
    await this.deleteThread(threadID)
    return true
  }

  getThread = async (threadID: string) => {
    const dialogThread = this.dialogs.get(threadID)
    if (!dialogThread) return
    return this.mapThread(dialogThread)
  }

  getThreads = async (inboxName: InboxName, pagination: PaginationArg): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    await this.waitForClientConnected()

    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 20
    let lastDate = 0

    const threads: Thread[] = []

    for await (const dialog of this.client.iterDialogs({ limit, ...(cursor && { offsetDate: Number(cursor) }) })) {
      if (!dialog?.id) continue
      threads.push(await this.mapThread(dialog))
      lastDate = dialog.message?.date ?? lastDate
    }

    return {
      items: threads,
      oldestCursor: lastDate.toString() ?? '*',
      hasMore: lastDate !== 0,
    }
  }

  private getMessageReplies = async (dialogId: BigInteger.BigInteger, messages: Api.Message[]) => {
    const replyToMessages: Api.Message[] = []
    const currentIds = messages.map(msg => msg.id)
    const unloadedReplies = messages.filter(m => m.replyToMsgId && !currentIds.includes(m.replyToMsgId)).map(m => m.replyToMsgId)
    for await (const msg of this.client.iterMessages(dialogId, { ids: unloadedReplies })) {
      if (msg) replyToMessages.push(msg)
    }
    return replyToMessages
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    await this.waitForClientConnected()
    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 50
    const messages: Api.Message[] = []
    for await (const msg of this.client.iterMessages(threadID, { limit, maxId: +cursor || 0 })) {
      if (!msg) continue
      this.storeMessage(msg)
      messages.push(msg)
    }
    const replies = await this.getMessageReplies(BigInteger(threadID), messages)
    replies.forEach(this.storeMessage)
    messages.push(...replies)

    setTimeout(() => this.emitParticipantsFromMessageAction(messages.filter(m => m.action)), 1_000)

    return {
      items: this.mapper.mapMessages(messages),
      hasMore: messages.length !== 0,
    }
  }

  sendMessage = async (threadID: string, msgContent: MessageContent, { quotedMessageID }: MessageSendOptions) => {
    const { text } = msgContent
    const file = await getMessageContent(msgContent)
    const msgSendParams: SendMessageParams = {
      parseMode: 'md',
      message: text,
      replyTo: quotedMessageID ? Number(quotedMessageID) : undefined,
      file,
    }
    const res = await this.client.sendMessage(threadID, msgSendParams)
    const fullMessage = await this.client.getMessages(threadID, { ids: res.id })
    const sentMessage = fullMessage.length ? fullMessage[0] : res
    this.storeMessage(sentMessage)
    return [this.mapper.mapMessage(sentMessage)]
  }

  editMessage = async (threadID: string, messageID: string, msgContent: MessageContent) => {
    let { text } = msgContent
    if (!msgContent.text || /^\s+$/.test(msgContent.text)) text = '.'
    const file = await getMessageContent(msgContent)
    await this.client.editMessage(threadID, { message: +messageID, text, file })
    return true
  }

  forwardMessage = async (threadID: string, messageID: string, threadIDs?: string[]): Promise<boolean> => {
    if (!threadIDs) return false
    const resArr = await Promise.all(threadIDs.map(async toThreadID => {
      const res = await this.client.forwardMessages(toThreadID, { messages: +messageID, fromPeer: threadID })
      return res.length
    }))
    return resArr.every(Boolean)
  }

  sendActivityIndicator = async (type: ActivityType, threadID: string) => {
    const action = {
      [ActivityType.TYPING]: new Api.SendMessageTypingAction(),
      [ActivityType.NONE]: new Api.SendMessageCancelAction(),
      [ActivityType.RECORDING_VOICE]: new Api.SendMessageRecordAudioAction(),
      [ActivityType.RECORDING_VIDEO]: new Api.SendMessageRecordVideoAction(),
    }[type]
    if (!action) return
    const peer = await this.client.getInputEntity(threadID)
    if (!peer || this.dialogs.get(threadID)?.isChannel) return
    this.client.invoke(new Api.messages.SetTyping({ peer, action }))
  }

  deleteMessage = async (threadID: string, messageID: string, forEveryone: boolean) => {
    await this.client.deleteMessages(undefined, [Number(messageID)], { revoke: forEveryone })
    return true
  }

  sendReadReceipt = async (threadID: string, messageID: string) =>
    this.client.markAsRead(threadID, +messageID, { clearMentions: true })

  markAsUnread = () => {
    this.client.invoke(new Api.messages.MarkDialogUnread({ unread: true }))
  }

  archiveThread = async (threadID: string, archived: boolean) => {
    const res = await this.client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({
        folderId: Number(archived), // 1 is archived folder, 0 is non archived
        peer: await this.client.getInputEntity(threadID),
      })],
    }))
    if ('updates' in res && res.updates.length === 0) {
      this.onEvent([{
        type: ServerEventType.TOAST,
        toast: {
          text: 'Can\'t archive this thread.',
        },
      }])
    }
  }

  getAsset = async (_, type: 'media' | 'photos', assetId: string, extension: string, messageId: string, extra?: string) => {
    if (!['media', 'photos'].includes(type)) {
      throw new Error(`Unknown media type ${type}`)
    }
    const filePathWithoutExt = this.getAssetPathWithoutExt(type, assetId)
    const filePath = this.getAssetPath(type, assetId, extension)
    if (await fileExists(filePathWithoutExt)) { // for backwards compatiblity, remove later
      await fsp.rename(filePathWithoutExt, filePath).catch(console.error)
    }
    if (!await fileExists(filePath)) {
      let buffer: Buffer
      if (type === 'media') {
        const media = this.messageMediaStore.get(+messageId)
        if (media) {
          buffer = await this.client.downloadMedia(media, { workers: 16 })
          this.messageMediaStore.delete(+messageId)
        } else {
          throw Error('message media not found')
        }
      } else if (type === 'photos') {
        buffer = await this.client.downloadProfilePhoto(assetId, {})
      }
      // tgs stickers only appear to work on thread refresh
      // only happens first time
      if (buffer) await fsp.writeFile(filePath, buffer)
      else throw Error(`telegram getAsset: No buffer or path for media ${type}/${assetId}/${messageId}/${extra}`)
    }
    return url.pathToFileURL(filePath).href
  }

  handleDeepLink = async (link: string) => {
    const [, , , , type, chatID, messageID, data] = link.split('/')
    if (type !== 'callback') return
    const res = await this.client.invoke(new Api.messages.GetBotCallbackAnswer({
      data: Buffer.from(data),
      peer: chatID,
      msgId: +messageID,
    }))
    if (!res.message) return
    this.onEvent([{
      type: ServerEventType.TOAST,
      toast: {
        text: res.message,
      },
    }])
  }

  addReaction = async (threadID: string, messageID: string, reactionKey: string) => {
    await this.client.invoke(new Api.messages.SendReaction({
      msgId: Number(messageID),
      peer: threadID,
      reaction: REACTIONS[reactionKey].render,
    }))
  }

  removeReaction = async (threadID: string, messageID: string) => {
    await this.client.invoke(new Api.messages.SendReaction({
      msgId: Number(messageID),
      peer: threadID,
      reaction: '',
    }))
  }

  private reconnect = async () => {
    texts.log('[telegram] reconnect()')
    if (this.client?.connected) return

    try {
      await this.client.connect()
    } finally {
      setTimeout(async () => { await this.reconnect() }, 5_000)
    }
  }

  onResumeFromSleep = async () => {
    await this.reconnect()
  }
}
