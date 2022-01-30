/* eslint-disable @typescript-eslint/no-throw-literal */
// eslint-disable-next-line

import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, MessageSendOptions, ActivityType, ReAuthError, StateSyncEvent, Participant, AccountInfo } from '@textshq/platform-sdk'
import { debounce } from 'lodash'
import { TelegramClient } from 'telegram'
import { NewMessage, NewMessageEvent } from 'telegram/events'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { SendMessageParams } from 'telegram/client/messages'
import { CustomFile } from 'telegram/client/uploads'
import { readFile } from 'fs/promises'
import bigInt from 'big-integer'
import { inspect } from 'util'
import { API_ID, API_HASH, REACTIONS, MUTED_FOREVER_CONSTANT } from './constants'
import { mapThread, mapMessage, mapMessages, mapUser, mapUserPresence, mapUserAction, idFromPeer, initMappers } from './mappers'
import { getAssetPath, initAssets, saveAsset } from './util'

type LoginEventCallback = (authState: any)=> void

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
    const buffer = await readFile(filePath)
    return new CustomFile(fileName, buffer.byteLength, filePath, buffer)
  } if (fileBuffer) {
    return new CustomFile(fileName, fileBuffer.length, filePath, fileBuffer)
  }
}

export default class TelegramAPI implements PlatformAPI {
  private client?: TelegramClient

  private authState: AuthState

  private accountInfo: AccountInfo

  private messageMediaStore = new Map<number, Api.Message>()

  private loginEventCallback: LoginEventCallback

  private stringSession?: StringSession

  private dialogs?: Map<string, Dialog> = new Map<string, Dialog>()

  private me: Api.User

  private loginInfo = {
    phoneNumber: undefined,
    phoneCodeHash: undefined,
    phoneCode: undefined,
    password: undefined,
  }

  init = async (session?: string, accountInfo?: AccountInfo) => {
    this.stringSession = session ? new StringSession(session) : new StringSession('')

    this.client = new TelegramClient(this.stringSession, API_ID, API_HASH, {
      connectionRetries: 5,
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

  private onUpdateNewMessage = async (newMessageEvent: NewMessageEvent) => {
    const { message } = newMessageEvent
    if (message.media && !(message.media instanceof Api.MessageMediaEmpty)) {
      this.messageMediaStore.set(message.id, message)
    }
    const threadID = message.chatId.toString()
    const mappedMessage = await mapMessage(message)
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'message',
      objectIDs: { threadID },
      entries: [mappedMessage],
    }
    this.onEvent([event])
  }

  private mapThread = async (dialog: Dialog) => {
    const messages = await this.client.getMessages(dialog.id, { limit: 20 })
    const mappedMessages = await mapMessages(messages)

    const participants = (dialog.isGroup || dialog.isChannel) ? [] : await this.client.getParticipants(dialog.id, {})
    if (!participants.length) {
      this.getAndEmitParticipants(dialog)
    }

    messages.forEach(msg => this.messageMediaStore.set(msg.id, msg))

    participants.push(this.me)
    const thread = await mapThread(dialog, mappedMessages, participants)
    const presenceEvents = participants.map(x => mapUserPresence(x.id.toJSNumber(), x.status))
    this.onEvent(presenceEvents)
    return thread
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
        id: idFromPeer(update.peer.peer).toString(),
        mutedUntil: new Date(update.notifySettings.muteUntil),
      }],
    }])
  }

  private onUpdateDeleteMessages(update: Api.UpdateDeleteMessages) {
    this.onEvent([
      {
        type: ServerEventType.STATE_SYNC,
        objectIDs: {
        },
        mutationType: 'delete',
        objectName: 'message',
        entries: update.messages.map(x => x.toString()),
      },
    ])
  }

  private onUpdateUserTyping(update: Api.UpdateUserTyping) {
    const event = mapUserAction(update)
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

  private onUpdateReadChannelInbox(update: Api.UpdateReadChannelInbox) {
    const threadID = update.channelId.toString()
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

  private onUpdateReadChannelOutbox(update: Api.UpdateReadChannelOutbox) {
    const threadID = update.channelId.toString()
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
    this.onEvent([mapUserPresence(update.userId.toJSNumber(), update.status)])
  }

  private async onUpdateEditMessage(update: Api.UpdateEditMessage) {
    if (update.message instanceof Api.MessageEmpty) return
    const threadID = idFromPeer(update.message.peerId).toString()
    const updatedMessage = await mapMessage(update.message)
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
    const entries = await mapMessages(res)
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
      else if (update instanceof Api.UpdateReadChannelInbox) this.onUpdateReadChannelInbox(update)
      else if (update instanceof Api.UpdateReadChannelOutbox) this.onUpdateReadChannelOutbox(update)
      else if (update instanceof Api.UpdateUserStatus) this.onUpdateUserStatus(update)
      else if (update instanceof Api.UpdateEditMessage) await this.onUpdateEditMessage(update)
      else if (update instanceof Api.UpdateReadMessagesContents) await this.onUpdateReadMessagesContents(update)
      else if (IS_DEV) console.log(inspect(update))
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
    await initAssets()
    this.me = await this.client.getMe() as Api.User
    this.registerUpdateListeners()
    initMappers(this.accountInfo.accountID)
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
    const user = this.client.getEntity(userId)
    if (user instanceof Api.User) {
      return mapUser(user)
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

  private getAndEmitParticipants = async (channel: Dialog) => {
    const members = await this.client.getParticipants(channel.id, {})
    if (!members.length) return
    const mappedMembers = await Promise.all(members.map(m => mapUser(m)))
    this.upsertParticipants(String(channel.id), mappedMembers)
  }

  logout = async () => {
    await this.client?.disconnect()
  }

  dispose = async () => {
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
      chatId: bigInt(threadID),
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

  getThreads = async (inboxName: InboxName): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    const dialogs = await this.client.getDialogs({})
    const threads = await Promise.all(dialogs.map(dialog => this.mapThread(dialog)))
    dialogs.forEach(dialog => this.dialogs.set(dialog.id.toString(), dialog))
    return {
      items: threads,
      oldestCursor: '*',
      hasMore: false,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 20
    const messages = await this.client.getMessages(threadID, { limit, maxId: +cursor || 0 })
    const items = await mapMessages(messages)
    return {
      items,
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
    await this.client.sendMessage(threadID, msgSendParams)
    return true
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
    const filePath = await getAssetPath(assetId)
    if (filePath) {
      return filePath
    }
    const buffer = await (() => {
      if (messageId) {
        const message = this.messageMediaStore.get(+messageId)
        if (!message) return
        this.messageMediaStore.delete(+messageId)
        return message.downloadMedia({})
      }
      return this.client.downloadProfilePhoto(assetId)
    })()

    return saveAsset(buffer, assetId)
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
