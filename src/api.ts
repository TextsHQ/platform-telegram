/* eslint-disable @typescript-eslint/no-throw-literal */
// eslint-disable-next-line

import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, MessageSendOptions, ActivityType, ReAuthError, StateSyncEvent, Participant, AccountInfo } from '@textshq/platform-sdk'
import { debounce, min } from 'lodash'
import { TelegramClient } from 'telegram'
import { NewMessage, NewMessageEvent } from 'telegram/events'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { SendMessageParams } from 'telegram/client/messages'
import { CustomFile } from 'telegram/client/uploads'
import path from 'path'
import fs from 'fs/promises'
import url from 'url'
import { getPeerId, resolveId } from 'telegram/Utils'
import type { CustomMessage } from 'telegram/tl/custom/message'
import BigInteger from 'big-integer'
import PQueue from 'p-queue'
import { API_ID, API_HASH, REACTIONS, MUTED_FOREVER_CONSTANT } from './constants'
import TelegramMapper from './mappers'
import { fileExists, stringifyCircular } from './util'

type LoginEventCallback = (authState: any)=> void
type AirgramSession = { dbKey: string }

const { IS_DEV } = texts
export enum AuthState {
  PHONE_INPUT,
  CODE_INPUT,
  PASSWORD_INPUT,
  READY,
}

if (IS_DEV) {
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  require('source-map-support').install()
}

async function getMessageContent(msgContent: MessageContent) {
  const { fileBuffer, fileName, filePath } = msgContent
  if (filePath) {
    const buffer = await fs.readFile(filePath)
    return new CustomFile(fileName, buffer.byteLength, filePath, buffer)
  } if (fileBuffer) {
    return new CustomFile(fileName, fileBuffer.length, filePath, fileBuffer)
  }
}
function isAirgramSession(session: string | AirgramSession): session is AirgramSession {
  return (session as AirgramSession)?.dbKey !== undefined
}

export default class TelegramAPI implements PlatformAPI {
  private client?: TelegramClient

  private authState: AuthState

  private accountInfo: AccountInfo

  private loginEventCallback: LoginEventCallback

  private stringSession?: StringSession

  private dialogs?: Map<string, Dialog> = new Map<string, Dialog>()

  private messageMediaStore = new Map<number, Api.TypeMessageMedia>()

  private chatIdMessageId = new Map<bigInt.BigInteger, number[]>()

  private dialogToParticipantIds = new Map<bigInt.BigInteger, bigInt.BigInteger[]>()

  private me: Api.User

  private mapper: TelegramMapper

  private loginInfo = {
    phoneNumber: undefined,
    phoneCodeHash: undefined,
    phoneCode: undefined,
    password: undefined,
  }

  init = async (session?: string | AirgramSession, accountInfo?: AccountInfo) => {
    if (isAirgramSession(session)) {
      console.log(accountInfo.dataDirPath)
      console.log(session.dbKey)
    } else {
      this.stringSession = session ? new StringSession(session) : new StringSession('')
    }

    this.client = new TelegramClient(this.stringSession, API_ID, API_HASH, {
      connectionRetries: 5,
      maxConcurrentDownloads: 4,
    })

    this.accountInfo = accountInfo

    await this.client.connect()

    this.authState = AuthState.PHONE_INPUT
    if (session) await this.afterLogin()
  }

  onLoginEvent = (onEvent: LoginEventCallback) => {
    this.loginEventCallback = onEvent
    this.loginEventCallback(this.authState)
  }

  login = async (creds: LoginCreds = {}): Promise<LoginResult> => {
    const mapError = (message: string) => {
      if (message === 'PASSWORD_HASH_INVALID') return 'Password is invalid.'
      if (message === 'PHONE_CODE_INVALID') return 'Code is invalid.'
      if (message === 'PHONE_NUMBER_INVALID') return 'Phone number is invalid.'
      return message
    }

    if (IS_DEV) console.log(JSON.stringify(creds.custom, null, 4))
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
          if (IS_DEV) console.log('PHONE_INPUT', JSON.stringify(res))
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
          if (IS_DEV) console.log('CODE_INPUT', JSON.stringify(res))
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
            password: async () => this.loginInfo.password,
            onError: async err => { console.log(err); return true },
          })
          this.authState = AuthState.READY
          break
        }
        case AuthState.READY:
        {
          if (IS_DEV) {
            const sessionString = this.stringSession.save()
            console.log((sessionString))
          }
          await this.afterLogin()
          return { type: 'success' }
        }
        default:
        {
          return { type: 'error' }
        }
      }
    } catch (e) {
      if (IS_DEV) console.log(JSON.stringify(e, null, 4))
      if (e.code === 401) this.authState = AuthState.PASSWORD_INPUT
      else return { type: 'error', errorMessage: mapError(e.errorMessage) }
    }

    this.loginEventCallback(this.authState)
    return { type: 'wait' }
  }

  downloadQueue: any

  private storeMessage(message: CustomMessage) {
    if (message.media) {
      this.messageMediaStore.set(message.id, message.media)
    }
    const thread = this.chatIdMessageId.get(message.chatId)
    if (thread) {
      thread.push(message.id)
    } else {
      this.chatIdMessageId.set(message.chatId, [message.id])
    }
  }

  private onUpdateNewMessage = async (newMessageEvent: NewMessageEvent) => {
    const { message } = newMessageEvent
    const threadID = message.chatId.toString()
    const mappedMessage = this.mapper.mapMessage(message)
    const chatParticipants = this.dialogToParticipantIds.get(message.chatId)
    if (!chatParticipants?.find(m => m === message.senderId)) {
      this.emitParticipantFromMessage(message.chatId, message.senderId)
    }
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

  private mapThread = (dialog: Dialog) => {
    const thread = this.mapper.mapThread(dialog)
    this.emitParticipants(dialog)
    return thread
  }

  private emitThread = async (thread: Thread) => {
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'thread',
      objectIDs: {
        threadID: thread.id,
      },
      entries: [thread],
    }
    this.onEvent([event])
  }

  private onUpdateChat = async (update: Api.UpdateChat) => {
    const chat = await this.client._getInputDialog(update.chatId)
    const thread = await this.mapThread(chat)
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'thread',
      objectIDs: {
        threadID: thread.id,
      },
      entries: [thread],
    }
    this.onEvent([event])
  }

  private onUpdateChatParticipant(update: Api.UpdateChatParticipant) {
    if (update.prevParticipant) {
      const chatId = update.chatId.toJSNumber()
      this.emitDeleteThread(chatId)
    }
  }

  private onUpdateChannelParticipant(update: Api.UpdateChannelParticipant) {
    if (update.prevParticipant) {
      const chatId = update.channelId.toJSNumber()
      this.emitDeleteThread(chatId)
    }
  }

  private onUpdateNotifySettings(update: Api.UpdateNotifySettings) {
    if (!('peer' in update.peer)) return
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      objectIDs: {},
      mutationType: 'update',
      objectName: 'thread',
      entries: [{
        id: TelegramMapper.idFromPeer(update.peer.peer).toString(),
        mutedUntil: new Date(update.notifySettings.muteUntil),
      }],
    }])
  }

  private onUpdateDeleteMessages(update: Api.UpdateDeleteMessages) {
    if (!update.messages?.length) return
    const threadID = Array.from(this.chatIdMessageId.entries()).find(thread => thread[1].find(message => message === update.messages[0]))
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

  private onUpdateUserTyping(update: Api.UpdateUserTyping) {
    const event = TelegramMapper.mapUserAction(update)
    if (event) this.onEvent([event])
  }

  private onUpdateDialogUnreadMark(update: Api.UpdateDialogUnreadMark) {
    if (!(update.peer instanceof Api.DialogPeer)) return
    if (!('chatId' in update.peer.peer)) return
    const threadID = update.peer.peer.chatId.toString()
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'update',
      objectName: 'thread',
      objectIDs: { threadID },
      entries: [
        {
          id: threadID,
          isUnread: update.unread,
        },
      ],
    }])
  }

  private onUpdateReadHistoryInbox(update: Api.UpdateReadHistoryInbox) {
    const threadID = getPeerId(update.peer)
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'update',
      objectName: 'thread',
      objectIDs: { threadID },
      entries: [
        {
          id: threadID,
          isUnread: update.stillUnreadCount > 0,
        },
      ],
    }])
  }

  private onUpdateReadHistoryOutbox(update: Api.UpdateReadHistoryOutbox) {
    const threadID = getPeerId(update.peer)
    const messageID = update.maxId.toString()
    const event: StateSyncEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'update',
      objectName: 'message',
      objectIDs: { threadID, messageID },
      entries: [
        {
          id: messageID,
          seen: true,
        },
      ],
    }
    this.onEvent([event])
  }

  private onUpdateUserStatus(update: Api.UpdateUserStatus) {
    this.onEvent([TelegramMapper.mapUserPresence(update.userId.toJSNumber(), update.status)])
  }

  private async onUpdateEditMessage(update: Api.UpdateEditMessage) {
    if (update.message instanceof Api.MessageEmpty) return
    const threadID = TelegramMapper.idFromPeer(update.message.peerId).toString()
    const updatedMessage = this.mapper.mapMessage(update.message)
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'update',
      objectName: 'message',
      objectIDs: { threadID, messageID: update.message.id.toString() },
      entries: [updatedMessage],
    }])
  }

  private onUpdateReadMessagesContents = async (update: Api.UpdateReadMessagesContents) => {
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
    this.client.addEventHandler(async (update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateChat) await this.onUpdateChat(update)
      else if (update instanceof Api.ChatParticipant) this.onUpdateChatParticipant(update)
      else if (update instanceof Api.ChannelParticipant) this.onUpdateChannelParticipant(update)
      else if (update instanceof Api.UpdateNotifySettings) this.onUpdateNotifySettings(update)
      else if (update instanceof Api.UpdateDeleteMessages) this.onUpdateDeleteMessages(update)
      else if (update instanceof Api.UpdateUserTyping) this.onUpdateUserTyping(update)
      else if (update instanceof Api.UpdateDialogUnreadMark) this.onUpdateDialogUnreadMark(update)
      else if (update instanceof Api.UpdateReadHistoryInbox) this.onUpdateReadHistoryInbox(update)
      else if (update instanceof Api.UpdateReadHistoryOutbox) this.onUpdateReadHistoryOutbox(update)
      else if (update instanceof Api.UpdateUserStatus) this.onUpdateUserStatus(update)
      else if (update instanceof Api.UpdateEditMessage) await this.onUpdateEditMessage(update)
      else if (update instanceof Api.UpdateReadMessagesContents) await this.onUpdateReadMessagesContents(update)
      else if (IS_DEV) console.log(stringifyCircular(update.className))
    })
  }

  private emitDeleteThread(chatId: number) {
    const threadID = chatId.toString()
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'delete',
      objectName: 'thread',
      objectIDs: {
        threadID,
      },
      entries: [threadID],
    }
    this.onEvent([event])
  }

  private afterLogin = async () => {
    this.me = await this.client.getMe() as Api.User
    this.registerUpdateListeners()
    this.mapper = new TelegramMapper(this.accountInfo)
    this.downloadQueue = new PQueue({ concurrency: 4 })
    this.createAssetsDir()
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

  private getUserById = async (userId: number | string) => {
    if (!userId) return
    const user = this.client.getInputEntity(userId)
    if (user instanceof Api.User) {
      return this.mapper.mapUser(user)
    }
  }

  private upsertParticipants(threadID: string, entries: Participant[]) {
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'participant',
      objectIDs: {
        threadID,
      },
      entries,
    }])
  }

  private dialogToParticipantIdsUpdate(dialogId: bigInt.BigInteger, participantIds: bigInt.BigInteger[]) {
    if (this.dialogToParticipantIds.has(dialogId)) this.dialogToParticipantIds.get(dialogId).push(...participantIds)
    else {
      this.dialogToParticipantIds.set(dialogId, participantIds)
    }
  }

  private emitParticipantFromMessage = async (dialogId: bigInt.BigInteger, userId: bigInt.BigInteger) => {
    const user = await this.client.getEntity(userId)
    if (user instanceof Api.User) {
      const mappedUser = this.mapper.mapUser(user)
      this.dialogToParticipantIdsUpdate(dialogId, [userId])
      this.upsertParticipants(String(dialogId), [mappedUser])
    }
  }

  private emitParticipants = async (dialog: Dialog) => {
    const limit = 256
    const members = await (async () => {
      try {
        return await this.client.getParticipants(dialog.id, { showTotal: true, limit })
      } catch (e) {
        if (e.code === 400) {
          // only channel admins can request users
          if (IS_DEV) console.log(`Admin required for this channel: ${dialog.name}`)
          return []
        }
        if (IS_DEV) console.log(`${Function.name} ${stringifyCircular(e, 2)}`)
        return []
      }
    })()

    if (!members.length) return
    const mappedMembers = await Promise.all(members.map(m => this.mapper.mapUser(m)))

    this.dialogToParticipantIdsUpdate(dialog.id, members.map(m => m.id))
    this.upsertParticipants(String(dialog.id), mappedMembers)
  }

  private saveAsset = async (buffer: Buffer, assetType: 'media' | 'photos', filename: string) => {
    const filePath = path.join(this.accountInfo.dataDirPath, assetType, filename)
    await fs.writeFile(filePath, buffer)
    return url.pathToFileURL(filePath).href
  }

  private getAssetPath = async (assetType: 'media' | 'photos', id: string | number) => {
    const filePath = path.join(this.accountInfo.dataDirPath, assetType, id.toString())
    return await fileExists(filePath) ? url.pathToFileURL(filePath).href : undefined
  }

  private createAssetsDir = () => {
    const mediaDir = path.join(this.accountInfo.dataDirPath, 'media')
    const photosDir = path.join(this.accountInfo.dataDirPath, 'photos')

    // doing it this way so there isn't a lot of try/catch
    fs.access(this.accountInfo.dataDirPath).catch(() => (fs.mkdir(this.accountInfo.dataDirPath)).catch())
    fs.access(mediaDir).catch(() => (fs.mkdir(mediaDir)).catch())
    fs.access(photosDir).catch(() => (fs.mkdir(photosDir)).catch())
  }

  private deleteAssetsDir = async () => {
    await fs.rm(this.accountInfo.dataDirPath, { recursive: true })
  }

  logout = async () => {
    await this.deleteAssetsDir()
  }

  dispose = async () => {
    await this.client?.disconnect()
  }

  getCurrentUser = (): CurrentUser => {
    const user: CurrentUser = {
      id: this.me.id.toString(),
      displayText: (this.me.username ? '@' + this.me.username : '') || ('+' + this.me.phone),
    }
    return user
  }

  subscribeToEvents = (onServerEvent: OnServerEventCallback) => {
    this.onServerEvent = onServerEvent
  }

  serializeSession = () => this.stringSession.save()

  searchUsers = async (query: string) => {
    const res = await this.client.invoke(new Api.contacts.Search({
      q: query,
    }))
    const userIds = res.users.map(user => user.id.toJSNumber())
    return Promise.all(userIds.map(async userId =>
      this.getUserById(userId)))
  }

  createThread = async (userIDs: string[], title?: string) => {
    if (userIDs.length === 0) return
    if (!title) return
    await this.client.invoke(new Api.messages.CreateChat({ users: userIDs, title }))
    return true
  }

  updateThread = async (threadID: string, updates: Partial<Thread>) => {
    if ('mutedUntil' in updates) {
      await this.client.invoke(new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({
          peer: this.dialogs[threadID].eqr,
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
    const dialogThread = this.dialogs[threadID]
    return this.mapThread(dialogThread)
  }

  getThreads = async (inboxName: InboxName, pagination: PaginationArg): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 10
    let lastDate = 0
    for await (const dialog of this.client.iterDialogs({ limit, ...(cursor && { offsetDate: Number(cursor) }) })) {
      this.dialogs[dialog.id.toString()] = dialog
      this.emitThread(this.mapThread(dialog))
      lastDate = dialog.message?.date
    }

    return {
      items: [],
      oldestCursor: lastDate.toString() ?? '*',
      hasMore: lastDate !== 0,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 20
    const messages = []
    for await (const msg of this.client.iterMessages(threadID, { limit, maxId: +cursor || 0 })) {
      this.storeMessage(msg)
      messages.push(msg)
    }
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
      replyTo: +quotedMessageID || undefined,
      file,
    }
    const res = await this.client.sendMessage(threadID, msgSendParams)
    this.storeMessage(res)
    return [this.mapper.mapMessage(res)]
  }

  editMessage = async (threadID: string, messageID: string, msgContent: MessageContent) => {
    let { text } = msgContent
    if (!msgContent.text || /^\s+$/.test(msgContent.text)) text = '.'
    const file = await getMessageContent(msgContent)
    await this.client.editMessage(threadID, { message: +messageID, text, file })
    return true
  }

  forwardMessage = async (threadID: string, messageID: string, threadIDs?: string[]): Promise<boolean> => {
    const resArr = await Promise.all(threadIDs.map(async toThreadID => {
      const res = await this.client.forwardMessages(threadID, { messages: +messageID, fromPeer: toThreadID })
      return res.length
    }))
    return resArr.every(Boolean)
  }

  sendActivityIndicator = async (type: ActivityType, threadID: string) => {
    const action = {
      [ActivityType.NONE]: new Api.SendMessageCancelAction(),
      [ActivityType.TYPING]: new Api.SendMessageTypingAction(),
      [ActivityType.NONE]: new Api.SendMessageCancelAction(),
      [ActivityType.RECORDING_VOICE]: new Api.SendMessageRecordAudioAction(),
      [ActivityType.RECORDING_VIDEO]: new Api.SendMessageRecordVideoAction(),
    }[type]
    if (!action) return
    this.client.invoke(new Api.messages.SetTyping({ peer: threadID, topMsgId: +threadID, action }))
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

  archiveThread = async () => {
    // await this.client.invoke(Api.{ chatId: +threadID, chatList: { _: archived ? 'chatListArchive' : 'chatListMain' } })
  }

  getAsset = async (type: string, assetId: string, messageId: string) => {
    if (type !== 'media' && type !== 'photos') return
    const filePath = await this.getAssetPath(type, assetId)
    if (filePath) {
      return filePath
    }

    let buffer: Buffer
    try {
      if (type === 'media') {
        const media = this.messageMediaStore.get(+messageId)
        if (media) {
          this.messageMediaStore.delete(+messageId)
          buffer = await this.downloadQueue.add(() => this.client.downloadMedia(media, { sizeType: 's' }))
        }
      } else if (type === 'photos') {
        buffer = await this.downloadQueue.add(() => this.client.downloadProfilePhoto(assetId, { isBig: false }))
      } else {
        if (IS_DEV) console.log(`Not a valid media type: ${type}`)
        return
      }
      if (buffer) {
        const savePath = await this.downloadQueue.add(() => this.saveAsset(buffer, type, assetId))
        return savePath
      }
    } catch (e) {
      if (IS_DEV) console.log(e)
    }
    if (IS_DEV) console.log(`No buffer or path for media ${type}/${assetId}/${messageId}`)
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
}
