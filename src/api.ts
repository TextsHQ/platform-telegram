/* eslint-disable @typescript-eslint/no-throw-literal */
// eslint-disable-next-line

import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, MessageSendOptions, ActivityType, ReAuthError, StateSyncEvent, Participant } from '@textshq/platform-sdk'
import { debounce } from 'lodash'
import { TelegramClient } from 'telegram'
import { NewMessage, NewMessageEvent } from 'telegram/events'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import bigInt, { BigInteger } from 'big-integer'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { TotalList } from 'telegram/Helpers'
import { API_ID, API_HASH } from './constants'
import { mapThread, mapMessage, mapMessages, mapUser, mapUserPresence, mapUserAction, idFromPeer } from './mappers'
import { getAssetURL, initAssets, saveAsset } from './util'

type SendMessageResolveFunction = (value: Message[])=> void
type GetAssetResolveFunction = (value: string)=> void
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

export default class TelegramAPI implements PlatformAPI {
  private client?: TelegramClient

  private authState: AuthState

  private sendMessageResolvers = new Map<number, SendMessageResolveFunction>()

  private getAssetResolvers = new Map<number, GetAssetResolveFunction>()

  private messageStore = new Map<string, Api.Message>()

  private loginEventCallback: LoginEventCallback

  private stringSession?: StringSession

  private dialogs?: TotalList<Dialog>

  private me: Api.User

  private loginInfo = {
    phoneNumber: undefined,
    phoneCodeHash: undefined,
    phoneCode: undefined,
    password: undefined,
  }

  init = async (session?: string) => {
    this.stringSession = session ? new StringSession(session) : new StringSession('')

    this.client = new TelegramClient(this.stringSession, API_ID, API_HASH, {
      connectionRetries: 5,
    })

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
          console.log(creds.custom)
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

  onUpdateNewMessage = async (newMessageEvent: NewMessageEvent) => {
    const { message } = newMessageEvent
    const threadID = message.chatId.toString()
    const mappedMessage = await mapMessage(message, this.me.id.toString())
    this.emitParticipantsFromMessages(threadID, [mappedMessage])
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'message',
      objectIDs: { threadID },
      entries: [mappedMessage],
    }
    this.onEvent([event])
  }

  private getProfilePhoto = async (id: BigInteger) => {
    const assetPath = await getAssetURL(id.toString())
    if (assetPath) return
    const buffer = await this.client.downloadProfilePhoto(id, { isBig: false })
    if (buffer.length !== 0) await saveAsset(buffer, id.toString())
    await getAssetURL(id.toString())
  }

  private mapThread = async (dialog: Dialog) => {
    const participants: Api.User[] = await this.client.getParticipants(dialog.id, {})
    const messages = (await this.client.getMessages(dialog.id, { limit: 20 }))
    const mappedMessages = await mapMessages(messages, this.me.id.toString())
    messages.forEach(m => {
      if (m.media) {
        this.messageStore.set(m.id.toString(), m)
      }
    })
    const thread = mapThread(dialog, mappedMessages, participants)
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
    // TODO
    this.onEvent([
      {
        type: ServerEventType.STATE_SYNC,
        objectIDs: {
          threadID: '0',
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

  private onUpdateEditMessage(update: Api.UpdateEditMessage) {
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'update',
      objectName: 'message',
      objectIDs: { threadID: String(idFromPeer(update.message.peerId)), messageID: String(update.message.id) },
      entries: [{
        id: String(update.message.id),
      }],
    }])
  }

  private onUpdateReadMessagesContents = async (update: Api.UpdateReadMessagesContents) => {
    const messageID = String(update.messages[0])
    const res = await this.client.getMessages(undefined, { ids: update.messages })
    const entries = await mapMessages(res, this.me.id.toString())
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
      else if (update instanceof Api.ChatParticipant) await this.onUpdateChatParticipant(update)
      else if (update instanceof Api.ChannelParticipant) await this.onUpdateChannelParticipant(update)
      else if (update instanceof Api.UpdateNotifySettings) await this.onUpdateNotifySettings(update)
      else if (update instanceof Api.UpdateDeleteMessages) await this.onUpdateDeleteMessages(update)
      else if (update instanceof Api.UpdateUserTyping) await this.onUpdateUserTyping(update)
      else if (update instanceof Api.UpdateDialogUnreadMark) await this.onUpdateDialogUnreadMark(update)
      else if (update instanceof Api.UpdateReadChannelInbox) await this.onUpdateReadChannelInbox(update)
      else if (update instanceof Api.UpdateReadChannelOutbox) await this.onUpdateReadChannelOutbox(update)
      else if (update instanceof Api.UpdateUserStatus) await this.onUpdateUserStatus(update)
      else if (update instanceof Api.UpdateEditMessage) await this.onUpdateEditMessage(update)
      else if (update instanceof Api.UpdateReadMessagesContents) await this.onUpdateReadMessagesContents(update)
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
  }

  logout = async () => {
    await this.client?.disconnect()
  }

  dispose = async () => {
  }

  getCurrentUser = (): CurrentUser => (
    {
      id: this.me.id.toString(),
      displayText: (this.me.username ? '@' + this.me.username : '') || ('+' + this.me.phone),
    })

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

  subscribeToEvents = (onServerEvent: OnServerEventCallback) => {
    this.onServerEvent = onServerEvent
  }

  serializeSession = () => this.stringSession.save()

  searchUsers = async (query: string) => {
    const res = await this.client.invoke(new Api.contacts.Search({
      q: query,
    }))
    const userIds = res.users.map(user => user.id.toJSNumber())
    return Promise.all(userIds.map(async userId => {
      const user = await this.getTGUser(userId)
      return mapUser(user)
    }))
  }

  createThread = async (userIDs: string[], title?: string) => {
    if (userIDs.length === 0) return
    const chat = await this.client.invoke(new Api.messages.CreateChat({ users: userIDs, title }))
    texts.log('createThread', chat)
    return true
    // return this.asyncMapThread(chat)
  }

  updateThread = async (threadID: string, updates: Partial<Thread>) => {
    if ('mutedUntil' in updates) {
      /* TODO
      await this.client.setChatNotificationSettings({
        chatId: +threadID,
        notificationSettings: {
          _: 'chatNotificationSettings',
          muteFor: updates.mutedUntil === 'forever' ? MUTED_FOREVER_CONSTANT : 0,
        },
      })
      */
      return true
    }
  }

  deleteThread = async (threadID: string) => {
    await this.client.invoke(new Api.messages.DeleteHistory({
      peer: threadID,
      revoke: true,
    }))
    await this.client.invoke(new Api.messages.DeleteChatUser({
      userId: 'me',
      chatId: bigInt(parseInt(threadID, 10)),
      revokeHistory: true,
    }))
  }

  reportThread = async (type: 'spam', threadID: string) => {
    const res = await this.client.invoke(new Api.account.ReportPeer({
      peer: threadID,
      reason: new Api.InputReportReasonSpam(),
    }))
    await this.deleteThread(threadID)
    return res
  }

  private getTGUser = async (userId: number) => {
    const res = await this.client.getEntity(
      userId,
    )
    if (res instanceof Api.User) return res
  }

  getUser = async ({ username }: { username: string }) => {
    if (!username) return
    const res = await this.client.invoke(
      new Api.contacts.Search({
        q: username,
      }),
    )
    const { users } = res
    if (users.length === 0) return
    const user = await this.getTGUser(users[0].id.toJSNumber())
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

  private emitParticipantsFromMessages = async (threadID: string, messages: Message[]) => {
    const senderIDs = [...new Set(messages.map(m => (m.senderID.startsWith('$thread') ? null : +m.senderID)).filter(Boolean))]
    const members = await Promise.all(senderIDs.map(x => this.getTGUser(x)))
    const mappedMembers = await Promise.all(members.map(m => mapUser(m)))
    this.upsertParticipants(threadID, mappedMembers)
  }

  getThread = async (threadID: string) => {
    const dialogThread = await this.dialogs.find(dialog => dialog.id.toString() === threadID)
    return this.mapThread(dialogThread)
  }

  getThreads = async (inboxName: InboxName): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    this.dialogs = await this.client.getDialogs({})
    const threads = await Promise.all(this.dialogs.map(dialog => this.mapThread(dialog)))
    return {
      items: threads,
      oldestCursor: '*',
      hasMore: false,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 20
    const messages = await this.client.getMessages(threadID, { limit, minId: +cursor || 0 })
    const items = await (await mapMessages(messages, this.me.id.toString()))
    this.emitParticipantsFromMessages(threadID, items)
    return {
      items,
      hasMore: messages.length !== 0,
    }
  }

  sendMessage = async (threadID: string, msgContent: MessageContent, { quotedMessageID }: MessageSendOptions) => {
    const res = await this.client.sendMessage(threadID, { message: msgContent.text, replyTo: +quotedMessageID || 0 })
    return new Promise<Message[]>(resolve => {
      const tmpId = res.id
      this.sendMessageResolvers.set(tmpId, resolve)
    })
  }

  editMessage = async (threadID: string, messageID: string, msgContent: MessageContent) => {
    let { text } = msgContent
    if (!msgContent.text || /^\s+$/.test(msgContent.text)) text = '.'
    await this.client.editMessage(threadID, { message: +messageID, text })
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
      [ActivityType.NONE]: Api.SendMessageCancelAction,
      [ActivityType.TYPING]: Api.SendMessageTypingAction,
      [ActivityType.RECORDING_VOICE]: Api.SendMessageRecordAudioAction,
      [ActivityType.RECORDING_VIDEO]: Api.SendMessageRecordVideoAction,
    }[type]
    if (action) return
    await this.client.invoke(new Api.messages.SetTyping({ peer: threadID, topMsgId: +threadID, action }))
  }

  deleteMessage = async (threadID: string, messageID: string, forEveryone: boolean) => {
    const res = await this.client.deleteMessages(undefined, [parseInt(messageID, 10)], { revoke: forEveryone })
    return res.length !== 0
  }

  sendReadReceipt = async (threadID: string, messageID: string) => {
    await this.client.markAsRead(+threadID, +messageID)
    const res = await this.client.markAsRead(threadID, +messageID, { clearMentions: true })
    return res
  }

  markAsUnread = () => {
    this.client.invoke(new Api.messages.MarkDialogUnread({ unread: true }))
  }

  archiveThread = async () => {
    // TDLib only?
    // await this.client.invoke(Api.{ chatId: +threadID, chatList: { _: archived ? 'chatListArchive' : 'chatListMain' } })
  }

  onThreadSelected = async () => {
  }

  getAsset = async (type: string, messageId: string, assetId: string) => {
    texts.log('get asset', type, messageId, assetId)
    console.log(type, messageId, assetId)
    const fileId = +assetId
    const filePath = await getAssetURL(assetId)
    if (filePath) {
      this.messageStore.delete(messageId)
      return filePath
    }
    if (type === 'profile') {
      await this.client.downloadProfilePhoto(fileId).then(buffer => saveAsset(buffer, assetId.toString()))
    } if (type === 'media') {
      const message = this.messageStore.get(messageId)
      await message.downloadMedia({}).then(buffer => saveAsset(buffer, assetId.toString()))
    }
    return getAssetURL(assetId)
  }

  handleDeepLink = async (link: string) => {
    const [,,,, type, chatID, messageID, data] = link.split('/')
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
}
