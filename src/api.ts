import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import rimraf from 'rimraf'
import { Airgram, ChatUnion, Message as TGMessage, FormattedTextInput, InputMessageContentInputUnion, InputMessageTextInput, InputFileInputUnion, isError, ChatMember, Chat, AuthorizationStateUnion, TDLibError, ApiResponse, BaseTdObject, User as TGUser } from 'airgram'
import { AUTHORIZATION_STATE, CHAT_MEMBER_STATUS, SECRET_CHAT_STATE, UPDATE } from '@airgram/constants'
import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, AccountInfo, MessageSendOptions, ActivityType, ReAuthError, OnConnStateChangeCallback, ConnectionStatus, StateSyncEvent } from '@textshq/platform-sdk'

import { API_ID, API_HASH } from './constants'
import { mapThread, mapMessage, mapMessages, mapUser, mapUserPresence } from './mappers'

const MAX_SIGNED_64BIT_NUMBER = '9223372036854775807'

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

type SendMessageResolveFunction = (value: Message[]) => void
type GetAssetResolveFunction = (value: string) => void

function getFileInput(msgContent: MessageContent, filePath: string, caption?: FormattedTextInput): InputMessageContentInputUnion {
  const fileInput: InputFileInputUnion = {
    _: 'inputFileLocal',
    path: filePath,
  }
  switch (msgContent.mimeType.split('/')[0]) {
    case 'image':
      return {
        _: 'inputMessagePhoto',
        photo: fileInput,
        caption,
      }
    case 'audio':
      if (msgContent.isRecordedAudio) {
        return {
          _: 'inputMessageVoiceNote',
          voiceNote: fileInput,
          caption,
        }
      }
      return {
        _: 'inputMessageAudio',
        audio: fileInput,
        caption,
      }
    case 'video':
      if (msgContent.isGif) {
        return {
          _: 'inputMessageAnimation',
          animation: fileInput,
          caption,
        }
      }
      return {
        _: 'inputMessageVideo',
        video: fileInput,
        caption,
      }
    default:
      return {
        _: 'inputMessageDocument',
        document: fileInput,
        caption,
      }
  }
}

async function getInputMessageContent(msgContent: MessageContent): Promise<InputMessageContentInputUnion> {
  const { text, filePath, fileBuffer, fileName } = msgContent
  const formattedTextInput: FormattedTextInput = text ? {
    _: 'formattedText',
    text,
  } : undefined
  const textInput: InputMessageTextInput = text ? {
    _: 'inputMessageText',
    text: formattedTextInput,
  } : undefined
  if (filePath) {
    return getFileInput(msgContent, filePath, formattedTextInput)
  }
  if (fileBuffer) {
    const tmpFilePath = path.join(os.tmpdir(), fileName || Math.random().toString(36))
    await fs.writeFile(tmpFilePath, fileBuffer)
    return getFileInput(msgContent, tmpFilePath, formattedTextInput)
    // TODO fs.unlink(tmpFilePath).catch(() => {})
  }
  return textInput
}

const tdlibPath = path.join(texts.constants.BUILD_DIR_PATH, 'platform-telegram', {
  darwin: `libtdjson-${process.arch}.dylib`,
  linux: 'libtdjson.so',
  win32: 'libtdjson.dll',
}[process.platform])

type Session = {
  dbKey: string
}

export default class TelegramAPI implements PlatformAPI {
  private airgram: Airgram

  private accountInfo: AccountInfo

  private authState: AuthorizationStateUnion

  private getThreadsDone = false

  private lastChat: ChatUnion = null

  private sendMessageResolvers = new Map<number, SendMessageResolveFunction>()

  private getAssetResolvers = new Map<number, GetAssetResolveFunction>()

  private loginEventCallback: Function

  private connStateChangeCallback: OnConnStateChangeCallback

  private secretChatIdToChatId = new Map<number, number>()

  private basicGroupIdToChatId = new Map<number, number>()

  private superGroupIdToChatId = new Map<number, number>()

  private session: Session

  private me: TGUser

  init = async (session: Session, accountInfo: AccountInfo) => {
    this.accountInfo = accountInfo
    if (session) {
      this.session = session
    } else {
      this.session = {
        dbKey: require('crypto').randomBytes(32).toString('hex')
      }
    }
    this.airgram = new Airgram({
      databaseEncryptionKey: this.session.dbKey,
      apiId: API_ID,
      apiHash: API_HASH,
      command: tdlibPath,
      logVerbosityLevel: texts.IS_DEV ? 2 : 0,
      useChatInfoDatabase: true,
      useSecretChats: true,
      databaseDirectory: path.join(accountInfo.dataDirPath, 'db'),
      filesDirectory: path.join(accountInfo.dataDirPath, 'files'),
    })
    this.airgram.on(UPDATE.updateAuthorizationState, ({ update }) => {
      this.authState = update.authorizationState
      this.loginEventCallback?.(update.authorizationState._)
      if (texts.IS_DEV) console.log(update)
      if (this.authState._ === AUTHORIZATION_STATE.authorizationStateClosed) {
        this.connStateChangeCallback({
          status: ConnectionStatus.UNAUTHORIZED
        })
        throw new ReAuthError('Session closed')
      }
    })
    if (session) await this.afterLogin()
  }

  onLoginEvent = (onEvent: Function) => {
    this.loginEventCallback = onEvent
    this.loginEventCallback(this.authState?._)
  }

  onConnectionStateChange = (onEvent: OnConnStateChangeCallback) => {
    this.connStateChangeCallback = onEvent
  }

  login = async (creds: LoginCreds): Promise<LoginResult> => {
    const { phoneNumber, code, password } = creds.custom
    switch (this.authState._) {
      case AUTHORIZATION_STATE.authorizationStateWaitPhoneNumber: {
        const res = await this.airgram.api.setAuthenticationPhoneNumber({ phoneNumber })
        const data = res.response
        if (isError(data)) return { type: 'error', errorMessage: data.message }
        return { type: 'wait' }
      }
      case AUTHORIZATION_STATE.authorizationStateWaitCode: {
        const res = await this.airgram.api.checkAuthenticationCode({ code })
        const data = res.response
        if (isError(data)) return { type: 'error', errorMessage: data.message }
        return { type: 'wait' }
      }
      case AUTHORIZATION_STATE.authorizationStateWaitPassword: {
        const res = await this.airgram.api.checkAuthenticationPassword({ password })
        const data = res.response
        if (isError(data)) return { type: 'error', errorMessage: data.message }
        return { type: 'wait' }
      }
      case AUTHORIZATION_STATE.authorizationStateReady: {
        await this.afterLogin()
        return { type: 'success' }
      }
    }
    return { type: 'error', errorMessage: this.authState._ }
  }

  private handleMessageUpdate = (tgMessage: TGMessage) => {
    if (tgMessage.sendingState) {
      // Sent message is handled in updateMessageSendSucceeded.
      return
    }
    const message = mapMessage(tgMessage)
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'message',
      objectIDs: {
        threadID: tgMessage.chatId.toString(),
      },
      entries: [message],
    }
    this.onEvent([event])
  }

  private asyncMapThread = async (chat: Chat) => {
    const participants = await this._getParticipants(chat)
    const presenceEvents = participants.map(x => mapUserPresence(x.id, x.status))
    this.onEvent(presenceEvents)
    return mapThread(chat, participants, this.accountInfo.accountID)
  }

  private registerUpdateListeners() {
    this.airgram.on(UPDATE.updateNewChat, async ({ update }) => {
      if (!this.getThreadsDone || !update.chat.positions.length) {
        // Existing threads will be handled by getThreads, no need to duplicate
        // here. And update.chat.lastMessage seems to be always null, which will
        // mess up thread timestamp.
        // If the chat has no position, no need to show it in thread list.
        return
      }
      const thread = await this.asyncMapThread(update.chat)
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
    })
    this.airgram.on(UPDATE.updateSecretChat, async ({ update }) => {
      if (update.secretChat.state._ === SECRET_CHAT_STATE.secretChatStateClosed) {
        // Secret chat is accepted by another device or closed.
        const chatId = this.secretChatIdToChatId.get(update.secretChat.id)
        if (!chatId) return
        this.emitDeleteThread(chatId)
        this.secretChatIdToChatId.delete(update.secretChat.id)
      }
    })
    this.airgram.on(UPDATE.updateBasicGroup, async ({ update }) => {
      const { status } = update.basicGroup
      if (
        status._ === CHAT_MEMBER_STATUS.chatMemberStatusLeft ||
          status._ === CHAT_MEMBER_STATUS.chatMemberStatusBanned ||
          (status._ === CHAT_MEMBER_STATUS.chatMemberStatusCreator && !status.isMember)
      ) {
        const chatId = this.basicGroupIdToChatId.get(update.basicGroup.id)
        if (!chatId) return
        this.emitDeleteThread(chatId)
        this.basicGroupIdToChatId.delete(update.basicGroup.id)
      }
    })
    this.airgram.on(UPDATE.updateSupergroup, async ({ update }) => {
      const { status } = update.supergroup
      if (
        status._ === CHAT_MEMBER_STATUS.chatMemberStatusLeft ||
          status._ === CHAT_MEMBER_STATUS.chatMemberStatusBanned ||
          (status._ === CHAT_MEMBER_STATUS.chatMemberStatusCreator && !status.isMember)
      ) {
        const chatId = this.superGroupIdToChatId.get(update.supergroup.id)
        if (!chatId) return
        this.emitDeleteThread(chatId)
        this.superGroupIdToChatId.delete(update.supergroup.id)
      }
    })
    this.airgram.on(UPDATE.updateNewMessage, async ({ update }) => {
      this.handleMessageUpdate(update.message)
    })
    this.airgram.on(UPDATE.updateMessageSendSucceeded, async ({ update }) => {
      const resolve = this.sendMessageResolvers.get(update.oldMessageId)
      if (!resolve) return console.warn('unable to find promise resolver for update.oldMessageId')
      resolve([mapMessage(update.message)])
      this.sendMessageResolvers.delete(update.oldMessageId)
    })
    this.airgram.on(UPDATE.updateDeleteMessages, async ({ update }) => {
      if (!update.isPermanent) {
        return
      }
      this.onEvent([
        {
          type: ServerEventType.STATE_SYNC,
          objectIDs: {
            threadID: update.chatId.toString(),
          },
          mutationType: 'delete',
          objectName: 'message',
          entries: update.messageIds.map(x => x.toString()),
        },
      ])
    })
    this.airgram.on(UPDATE.updateUserChatAction, async ({ update }) => {
      switch (update.action._) {
        case 'chatActionTyping': {
          return this.onEvent([{
            type: ServerEventType.PARTICIPANT_TYPING,
            typing: true,
            threadID: update.chatId.toString(),
            participantID: update.userId.toString(),
            durationMs: 180_000,
          }])
        }
        case 'chatActionCancel':
          return this.onEvent([{
            type: ServerEventType.PARTICIPANT_TYPING,
            typing: false,
            threadID: update.chatId.toString(),
            participantID: update.userId.toString(),
          }])
        default:
      }
    })
    this.airgram.on(UPDATE.updateFile, async ({ update }) => {
      const resolve = this.getAssetResolvers.get(update.file.id)
      if (resolve && update.file.local.isDownloadingCompleted && update.file.local.path) {
        resolve(`file://${update.file.local.path}`)
        this.getAssetResolvers.delete(update.file.id)
      }
    })
    this.airgram.on(UPDATE.updateChatIsMarkedAsUnread, async ({ update }) => {
      const threadID = update.chatId.toString()
      this.onEvent([{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'thread',
        objectIDs: { threadID },
        entries: [
          {
            id: threadID,
            isUnread: update.isMarkedAsUnread,
          },
        ],
      }])
    })
    this.airgram.on(UPDATE.updateChatReadInbox, async ({ update }) => {
      if (!this.getThreadsDone) return
      const threadID = update.chatId.toString()
      this.onEvent([{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'thread',
        objectIDs: { threadID },
        entries: [
          {
            id: threadID,
            isUnread: update.unreadCount > 0,
          },
        ],
      }])
    })
    this.airgram.on(UPDATE.updateUserStatus, async ({ update }) => {
      this.onEvent([mapUserPresence(update.userId, update.status)])
    })
    this.airgram.on(UPDATE.updateChatReadOutbox, async ({ update }) => {
      const threadID = update.chatId.toString()
      const messageID = update.lastReadOutboxMessageId.toString()
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
    this.registerUpdateListeners()
    this.me = toObject(await this.airgram.api.getMe())
  }

  logout = async () => {
    await this.airgram?.api.logOut()
    return new Promise<void>(resolve => {
      rimraf(this.accountInfo?.dataDirPath, () => {
        resolve()
      })
    })
  }

  dispose = async () => {
    await this.airgram.api.close()
  }

  getCurrentUser = (): CurrentUser => ({
    ...mapUser(this.me, this.accountInfo.accountID),
    displayText: (this.me.username ? '@' + this.me.username : '') || this.me.phoneNumber,
  })

  private onEvent: OnServerEventCallback = () => {}

  subscribeToEvents = (onEvent: OnServerEventCallback) => {
    this.onEvent = onEvent
  }

  serializeSession = () => this.session

  searchUsers = async (query: string) => {
    const res = await this.airgram.api.searchContacts({
      query,
      limit: 20,
    })
    const { userIds } = toObject(res)
    return Promise.all(userIds.map(async userId => {
      const user = await this._getUser(userId)
      return mapUser(user, this.accountInfo.accountID)
    }))
  }

  createThread = async (userIDs: string[], title?: string) => {
    if (userIDs.length === 0) return
    if (userIDs.length === 1) {
      const chatResponse = await this.airgram.api.createPrivateChat({
        userId: +userIDs[0],
      })
      return this.asyncMapThread(toObject(chatResponse))
    }
    const res = await this.airgram.api.createNewBasicGroupChat({
      userIds: userIDs.map(Number),
      title,
    })
    const chat = toObject(res)
    return this.asyncMapThread(chat)
  }

  deleteThread = async (threadID: string) => {
    await this.airgram.api.deleteChatHistory({
      chatId: +threadID,
      removeFromChatList: true,
    })
  }

  private _getUser = async (userId: number) => {
    const res = await this.airgram.api.getUser({ userId })
    return toObject(res)
  }

  private _getParticipants = async (chat: ChatUnion) => {
    const mapMembers = (members: ChatMember[]) => Promise.all(members.map(member => this._getUser(member.userId)))
    switch (chat.type._) {
      case 'chatTypePrivate': {
        const participant = await this._getUser(chat.type.userId)
        return [participant, this.me]
      }
      case 'chatTypeSecret': {
        this.secretChatIdToChatId.set(chat.type.secretChatId, chat.id)
        const participant = await this._getUser(chat.type.userId)
        return [participant, this.me]
      }
      case 'chatTypeBasicGroup': {
        this.basicGroupIdToChatId.set(chat.type.basicGroupId, chat.id)
        const res = await this.airgram.api.getBasicGroupFullInfo({ basicGroupId: chat.type.basicGroupId })
        const { members } = toObject(res)
        return mapMembers(members)
      }
      case 'chatTypeSupergroup': {
        this.superGroupIdToChatId.set(chat.type.supergroupId, chat.id)
        const supergroupRes = await this.airgram.api.getSupergroupFullInfo({ supergroupId: chat.type.supergroupId })
        const supergroup = toObject(supergroupRes)
        if (!supergroup.canGetMembers) {
          return []
        }
        const membersRes = await this.airgram.api.getSupergroupMembers({
          supergroupId: chat.type.supergroupId,
          limit: 256, // random limit
        })
        const { members } = toObject(membersRes)
        return mapMembers(members)
      }
      default:
        return []
    }
  }

  getThreads = async (inboxName: InboxName, { cursor, direction }: PaginationArg = { cursor: null, direction: null }): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    const limit = 25
    const chatsResponse = await this.airgram.api.getChats({
      limit,
      offsetChatId: +cursor,
      offsetOrder: (cursor && this.lastChat)
        ? this.lastChat.positions.find(x => x.list._ === 'chatListMain').order
        : MAX_SIGNED_64BIT_NUMBER,
    })
    const { chatIds } = toObject(chatsResponse)
    const chats = await Promise.all(chatIds.map(async chatId => {
      const chatResponse = await this.airgram.api.getChat({ chatId })
      return toObject(chatResponse)
    }))
    this.lastChat = chats[chats.length - 1]
    const items = await Promise.all(chats.map(this.asyncMapThread))
    const hasMore = items.length === limit
    if (!hasMore) {
      this.getThreadsDone = true
    }
    return {
      items,
      oldestCursor: items[items.length - 1]?.id,
      hasMore,
    }
  }

  getMessages = async (threadID: string, { cursor, direction }: PaginationArg = { cursor: null, direction: null }): Promise<Paginated<Message>> => {
    const messagesResponse = await this.airgram.api.getChatHistory({
      limit: 20,
      chatId: +threadID,
      fromMessageId: +cursor || 0,
    })
    const { messages } = toObject(messagesResponse)
    // When fromMessageId is 0, getChatHistory returns only one message.
    // See https://core.telegram.org/tdlib/getting-started#getting-chat-messages
    if (!cursor && messages.length === 1) {
      const res = await this.airgram.api.getChatHistory({
        limit: 20,
        chatId: +threadID,
        fromMessageId: messages[0].id,
      })
      messages.push(...toObject(res).messages)
    }
    return {
      items: mapMessages(messages).reverse(),
      hasMore: messages.length >= 20,
    }
  }

  sendMessage = async (threadID: string, msgContent: MessageContent, { quotedMessageID }: MessageSendOptions) => {
    const inputMessageContent = await getInputMessageContent(msgContent)
    if (!inputMessageContent) return false
    const res = await this.airgram.api.sendMessage({
      chatId: Number(threadID),
      messageThreadId: 0,
      replyToMessageId: +quotedMessageID || 0,
      inputMessageContent,
    })
    return new Promise<Message[]>(resolve => {
      const tmpId = toObject(res).id
      this.sendMessageResolvers.set(tmpId, resolve)
    })
  }

  forwardMessage = async (threadID: string, messageID: string, threadIDs?: string[], userIDs?: string[]): Promise<boolean> => {
    const resArr = await Promise.all(threadIDs.map(async toThreadID => {
      const res = await this.airgram.api.forwardMessages({
        chatId: +toThreadID,
        fromChatId: +threadID,
        messageIds: [+messageID],
      })
      return !isError(toObject(res))
    }))
    return resArr.every(Boolean)
  }

  sendActivityIndicator = async (type: ActivityType, threadID: string) => {
    const _ = {
      [ActivityType.NONE]: 'chatActionCancel', // todo review
      [ActivityType.TYPING]: 'chatActionTyping',
      [ActivityType.RECORDING_VOICE]: 'ChatActionRecordingVoiceNoteInput',
    }[type]
    if (!_) return
    await this.airgram.api.sendChatAction({
      chatId: +threadID,
      messageThreadId: 0,
      action: { _ },
    })
  }

  deleteMessage = async (threadID: string, messageID: string, forEveryone: boolean) => {
    const res = await this.airgram.api.deleteMessages({
      chatId: +threadID,
      messageIds: [+messageID],
      revoke: forEveryone,
    })
    return !isError(toObject(res))
  }

  sendReadReceipt = async (threadID: string, messageID: string) => {
    await this.airgram.api.toggleChatIsMarkedAsUnread({
      chatId: +threadID,
      isMarkedAsUnread: false,
    })
    const res = await this.airgram.api.viewMessages({
      chatId: +threadID,
      messageThreadId: 0,
      messageIds: [+messageID],
      forceRead: true,
    })
    return !isError(toObject(res))
  }

  markAsUnread = (threadID: string) => {
    this.airgram.api.toggleChatIsMarkedAsUnread({
      chatId: +threadID,
      isMarkedAsUnread: true,
    })
  }

  private lastChatID: number

  onThreadSelected = async (threadID: string) => {
    if (this.lastChatID) await this.airgram.api.closeChat({ chatId: this.lastChatID })
    this.lastChatID = +threadID
    if (threadID) await this.airgram.api.openChat({ chatId: +threadID })
  }

  getAsset = async (type: string, fileIdStr: string) => {
    texts.log('get asset', type, fileIdStr)
    if (type !== 'file') throw new Error('unknown asset type')
    const fileId = +fileIdStr
    await this.airgram.api.downloadFile({
      fileId,
      priority: 32,
    })
    return new Promise<string>(resolve => {
      this.getAssetResolvers.set(fileId, resolve)
    })
  }
}
