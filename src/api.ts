// this should be the first import to fix PATH env variable on windows
// eslint-disable-next-line
// import { copyDLLsForWindows, IS_WINDOWS } from './windows'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import rimraf from 'rimraf'
import { Airgram, ChatUnion, Message as TGMessage, FormattedTextInput, InputMessageContentInputUnion, InputMessageTextInput, InputFileInputUnion, isError, ChatMember, Chat, AuthorizationStateUnion, TDLibError, ApiResponse, BaseTdObject, User as TGUser } from 'airgram'
import { AUTHORIZATION_STATE, CHAT_MEMBER_STATUS, SECRET_CHAT_STATE, UPDATE } from '@airgram/constants'
import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, AccountInfo, MessageSendOptions, ActivityType, ReAuthError, OnConnStateChangeCallback, ConnectionStatus, StateSyncEvent, Participant } from '@textshq/platform-sdk'
import { debounce } from 'lodash'

import { API_ID, API_HASH, BINARIES_DIR_PATH, MUTED_FOREVER_CONSTANT } from './constants'
import { mapThread, mapMessage, mapMessages, mapUser, mapUserPresence, mapMuteFor, getMessageButtons, mapTextFooter, mapMessageUpdateText, mapUserAction } from './mappers'
import { fileExists } from './util'

type SendMessageResolveFunction = (value: Message[]) => void
type GetAssetResolveFunction = (value: string) => void
type Session = { dbKey: string }
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
    const tmpFilePath = path.join(os.tmpdir(), `${Math.random().toString(36)}.${fileName}`)
    await fs.writeFile(tmpFilePath, fileBuffer)
    return getFileInput(msgContent, tmpFilePath, formattedTextInput)
    // TODO fs.unlink(tmpFilePath).catch(() => {})
  }
  return textInput
}

const tdlibPath = path.join(BINARIES_DIR_PATH, {
  darwin: `${process.platform}-${process.arch}/libtdjson.dylib`,
  linux: `${process.platform}-${process.arch}/libtdjson.so`,
  win32: `${process.platform}-${process.arch}/libtdjson.dll`,
}[process.platform])

export default class TelegramAPI implements PlatformAPI {
  private airgram: Airgram

  private accountInfo: AccountInfo

  private authState: AuthorizationStateUnion

  private sendMessageResolvers = new Map<number, SendMessageResolveFunction>()

  private getAssetResolvers = new Map<number, GetAssetResolveFunction>()

  private fileIdToPath = new Map<number, string>()

  private loginEventCallback: LoginEventCallback

  private connStateChangeCallback: OnConnStateChangeCallback

  private secretChatIdToChatId = new Map<number, number>()

  private basicGroupIdToChatId = new Map<number, number>()

  private superGroupIdToChatId = new Map<number, number>()

  private superGroupThreads = new Set<string>()

  private session: Session

  private me: TGUser

  init = async (session: Session, accountInfo: AccountInfo) => {
    texts.log({ tdlibPath })
    const tdlibExists = await fileExists(tdlibPath)
    if (!tdlibExists) {
      throw new Error(`tdlib not found for ${process.platform} ${process.arch}`)
    }

    // if (IS_WINDOWS) {
    //   await copyDLLsForWindows()
    // }

    this.accountInfo = accountInfo
    this.session = session || { dbKey: crypto.randomBytes(32).toString('hex') }
    this.airgram = new Airgram({
      databaseEncryptionKey: this.session.dbKey,
      apiId: API_ID,
      apiHash: API_HASH,
      command: tdlibPath,
      // deviceModel: undefined,
      applicationVersion: texts.constants.APP_VERSION,
      systemVersion: `${os.platform()} ${os.release()}`,
      logVerbosityLevel: texts.IS_DEV ? 2 : 0,
      useFileDatabase: true,
      useChatInfoDatabase: true,
      useMessageDatabase: true,
      useSecretChats: true,
      enableStorageOptimizer: true,
      ignoreFileNames: false,
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
    // if (texts.IS_DEV) {
    //   this.airgram.use((ctx, next) => {
    //     if ('update' in ctx) {
    //       console.log(`[${ctx._}]`, JSON.stringify(ctx.update))
    //     }
    //     return next()
    //   })
    // }
  }

  onLoginEvent = (onEvent: LoginEventCallback) => {
    this.loginEventCallback = onEvent
    this.loginEventCallback(this.authState?._)
  }

  onConnectionStateChange = (onEvent: OnConnStateChangeCallback) => {
    this.connStateChangeCallback = onEvent
  }

  login = async (creds: LoginCreds = {}): Promise<LoginResult> => {
    const mapError = (message: string) => {
      if (message === 'PASSWORD_HASH_INVALID') return 'Password is invalid.'
      if (message === 'PHONE_CODE_INVALID') return 'Code is invalid.'
      if (message === 'PHONE_NUMBER_INVALID') return 'Phone number is invalid.'
      return message
    }
    const { phoneNumber, code, password } = creds.custom || {}
    switch (this.authState._) {
      case AUTHORIZATION_STATE.authorizationStateWaitPhoneNumber: {
        const res = await this.airgram.api.setAuthenticationPhoneNumber({ phoneNumber })
        const data = res.response
        if (isError(data)) return { type: 'error', errorMessage: mapError(data.message) }
        return { type: 'wait' }
      }
      case AUTHORIZATION_STATE.authorizationStateWaitCode: {
        const res = await this.airgram.api.checkAuthenticationCode({ code })
        const data = res.response
        if (isError(data)) return { type: 'error', errorMessage: mapError(data.message) }
        return { type: 'wait' }
      }
      case AUTHORIZATION_STATE.authorizationStateWaitPassword: {
        const res = await this.airgram.api.checkAuthenticationPassword({ password })
        const data = res.response
        if (isError(data)) return { type: 'error', errorMessage: mapError(data.message) }
        return { type: 'wait' }
      }
      case AUTHORIZATION_STATE.authorizationStateReady: {
        await this.afterLogin()
        return { type: 'success' }
      }
    }
    return { type: 'error', errorMessage: this.authState._ }
  }

  private onUpdateNewMessage = (tgMessage: TGMessage) => {
    if (tgMessage.sendingState) {
      // Sent message is handled in updateMessageSendSucceeded.
      return
    }
    const message = mapMessage(tgMessage, this.accountInfo.accountID)
    const threadID = tgMessage.chatId.toString()
    this.emitParticipantsFromMessages(threadID, [message])
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'message',
      objectIDs: { threadID },
      entries: [message],
    }
    this.onEvent([event])
  }

  private asyncMapThread = async (chat: Chat) => {
    const isSuperGroup = chat.type._ == 'chatTypeSupergroup'
    const participants: TGUser[] = isSuperGroup ? [] : await this._getParticipants(chat)

    const thread = mapThread(chat, participants, this.accountInfo.accountID)
    if (isSuperGroup) {
      // Intentionally not using `await` to not block getThreads.
      this.getAndEmitParticipants(chat)
      if (thread.messages.items.length) {
        setTimeout(() => {
          this.emitParticipantsFromMessages(chat.id.toString(), thread.messages.items)
        }, 100) // todo revisit
      }
    }
    // const presenceEvents = participants.map(x => mapUserPresence(x.id, x.status))
    // this.onEvent(presenceEvents)
    return thread
  }

  private registerUpdateListeners() {
    this.airgram.on(UPDATE.updateMessageSendSucceeded, ({ update }) => {
      const resolve = this.sendMessageResolvers.get(update.oldMessageId)
      if (!resolve) {
        return console.warn('update.updateMessageSendSucceeded: unable to find promise resolver for', update.oldMessageId)
      }
      resolve([mapMessage(update.message, this.accountInfo.accountID)])
      this.sendMessageResolvers.delete(update.oldMessageId)
    })

    this.airgram.on(UPDATE.updateNewChat, async ({ update }) => {
      texts.log(`[updateNewChat]`, update.chat.id, update.chat.title, update.chat.positions.length)
      const chat = toObject(await this.airgram.api.getChat({ chatId: update.chat.id }))
      if (!chat.positions.length) return
      const thread = await this.asyncMapThread(chat)
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
    this.airgram.on(UPDATE.updateSecretChat, ({ update }) => {
      if (update.secretChat.state._ === SECRET_CHAT_STATE.secretChatStateClosed) {
        // Secret chat is accepted by another device or closed.
        const chatId = this.secretChatIdToChatId.get(update.secretChat.id)
        if (!chatId) return
        this.emitDeleteThread(chatId)
        this.secretChatIdToChatId.delete(update.secretChat.id)
      }
    })
    this.airgram.on(UPDATE.updateBasicGroup, ({ update }) => {
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
    this.airgram.on(UPDATE.updateSupergroup, ({ update }) => {
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
    this.airgram.on(UPDATE.updateChatNotificationSettings, ({ update }) => {
      this.onEvent([{
        type: ServerEventType.STATE_SYNC,
        objectIDs: {},
        mutationType: 'update',
        objectName: 'thread',
        entries: [{
          id: update.chatId.toString(),
          mutedUntil: mapMuteFor(update.notificationSettings.muteFor),
        }],
      }])
    })
    this.airgram.on(UPDATE.updateNewMessage, ({ update }) => {
      this.onUpdateNewMessage(update.message)
    })
    this.airgram.on(UPDATE.updateDeleteMessages, ({ update }) => {
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
    this.airgram.on(UPDATE.updateUserChatAction, ({ update }) => {
      const event = mapUserAction(update)
      if (event) this.onEvent([event])
    })
    this.airgram.on(UPDATE.updateFile, ({ update }) => {
      const fileID = update.file.id
      const resolve = this.getAssetResolvers.get(fileID)
      if (!resolve) return console.warn('unable to find promise resolver for update.updateFile', fileID)
      if (update.file.local.isDownloadingCompleted && update.file.local.path) {
        const filePath = `file://${encodeURI(update.file.local.path)}`
        this.fileIdToPath.set(fileID, filePath)
        resolve(filePath)
        this.getAssetResolvers.delete(fileID)
      }
    })
    this.airgram.on(UPDATE.updateChatIsMarkedAsUnread, ({ update }) => {
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
    this.airgram.on(UPDATE.updateChatReadInbox, ({ update }) => {
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
    this.airgram.on(UPDATE.updateUserStatus, ({ update }) => {
      this.onEvent([mapUserPresence(update.userId, update.status)])
    })
    this.airgram.on(UPDATE.updateChatReadOutbox, ({ update }) => {
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
    this.airgram.on(UPDATE.updateMessageEdited, ({ update }) => {
      this.onEvent([{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'message',
        objectIDs: { threadID: String(update.chatId), messageID: String(update.messageId) },
        entries: [{
          id: String(update.messageId),
          editedTimestamp: update.editDate ? new Date(update.editDate * 1000) : undefined,
          buttons: getMessageButtons(update.replyMarkup, this.accountInfo.accountID, update.chatId, update.messageId)
        }],
      }])
    })
    this.airgram.on(UPDATE.updateMessageContent, async ({ update }) => {
      const messageID = String(update.messageId)
      const threadID = String(update.chatId)
      // since most of the time we get `messageText` updates, we only handle that here and inefficiently fetch the whole message in other cases
      // we should be handling all other message content types after refactoring mapMessage()
      if (update.newContent._ === 'messageText') {
        this.onEvent([{
          type: ServerEventType.STATE_SYNC,
          mutationType: 'update',
          objectName: 'message',
          objectIDs: { threadID, messageID },
          entries: [mapMessageUpdateText(messageID, update.newContent)],
        }])
        return
      }
      const res = await this.airgram.api.getMessage({
        chatId: update.chatId,
        messageId: update.messageId,
      })
      const message = toObject(res)
      this.onEvent([{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'message',
        objectIDs: { threadID, messageID },
        entries: [mapMessage(message, this.accountInfo.accountID)],
      }])
    })
    this.airgram.on('updateMessageInteractionInfo', ({ update }) => {
      this.onEvent([{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'message',
        objectIDs: { threadID: String(update.chatId), messageID: String(update.messageId) },
        entries: [{
          id: String(update.messageId),
          textFooter: mapTextFooter(update.interactionInfo),
        }],
      }])
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
    this.me = toObject(await this.airgram.api.getMe())
    this.registerUpdateListeners()
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
    displayText: (this.me.username ? '@' + this.me.username : '') || ('+' + this.me.phoneNumber),
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

  serializeSession = () => this.session

  searchUsers = async (query: string) => {
    const res = await this.airgram.api.searchContacts({
      query,
      limit: 20,
    })
    const { userIds } = toObject(res)
    return Promise.all(userIds.map(async userId => {
      const user = await this.getTGUser(userId)
      return mapUser(user, this.accountInfo.accountID)
    }))
  }

  createThread = async (userIDs: string[], title?: string) => {
    if (userIDs.length === 0) return
    if (userIDs.length === 1) {
      const chatResponse = await this.airgram.api.createPrivateChat({ userId: +userIDs[0] })
      return this.asyncMapThread(toObject(chatResponse))
    }
    const res = await this.airgram.api.createNewBasicGroupChat({
      userIds: userIDs.map(Number),
      title,
    })
    const chat = toObject(res)
    return this.asyncMapThread(chat)
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
    await this.airgram.api.deleteChatHistory({
      chatId: +threadID,
      removeFromChatList: true,
    })
    await this.airgram.api.leaveChat({ chatId: +threadID })
  }

  reportThread = async (type: 'spam', threadID: string) => {
    const res = await this.airgram.api.reportChat({
      chatId: +threadID,
      reason: {
        _: 'chatReportReasonSpam',
      },
    })
    await this.deleteThread(threadID)
    return toObject(res)._ === 'ok'
  }

  private getTGUser = async (userId: number) => {
    const res = await this.airgram.api.getUser({ userId })
    return toObject(res)
  }

  getUser = async ({ username }: { username: string }) => {
    if (!username) return
    const res = await this.airgram.api.searchPublicChat({ username })
    const chat = toObject(res)
    if (isError(chat)) return
    if (chat.type._ !== 'chatTypePrivate') return
    const user = await this.getTGUser(chat.type.userId)
    return mapUser(user, this.accountInfo.accountID)
  }

  private _getParticipants = async (chat: ChatUnion) => {
    const mapMembers = (members: ChatMember[]) =>
      Promise.all(
        members.map(member =>
          member.memberId._ === 'messageSenderUser' && this.getTGUser(member.memberId.userId)))
    switch (chat.type._) {
      case 'chatTypePrivate': {
        const participant = await this.getTGUser(chat.type.userId)
        return [participant]
      }
      case 'chatTypeSecret': {
        this.secretChatIdToChatId.set(chat.type.secretChatId, chat.id)
        const participant = await this.getTGUser(chat.type.userId)
        return [participant]
      }
      case 'chatTypeBasicGroup': {
        this.basicGroupIdToChatId.set(chat.type.basicGroupId, chat.id)
        const res = await this.airgram.api.getBasicGroupFullInfo({ basicGroupId: chat.type.basicGroupId })
        const { members } = toObject(res)
        return mapMembers(members)
      }
      case 'chatTypeSupergroup': {
        this.superGroupThreads.add(chat.id.toString())
        this.superGroupIdToChatId.set(chat.type.supergroupId, chat.id)
        return []
        // const supergroupRes = await this.airgram.api.getSupergroupFullInfo({ supergroupId: chat.type.supergroupId })
        // const supergroup = toObject(supergroupRes)
        // if (!supergroup.canGetMembers) {
        //   return []
        // }
        // const membersRes = await this.airgram.api.getSupergroupMembers({
        //   supergroupId: chat.type.supergroupId,
        //   limit: 256, // todo, random limit
        // })
        // const { members } = toObject(membersRes)
        // return mapMembers(members)
      }
      default:
        return []
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

  private getAndEmitParticipants = async (chat: ChatUnion) => {
    const members = await this._getParticipants(chat)
    if (!members.length) return
    this.upsertParticipants(String(chat.id), members.map(m => mapUser(m, this.accountInfo.accountID)))
  }

  private emitParticipantsFromMessages = async (threadID: string, messages: Message[]) => {
    if (!this.superGroupThreads.has(threadID)) {
      // Only need to emit participant for supergroup.
      return
    }
    const senderIDs = [...new Set(messages.map(m => m.senderID.startsWith('$thread') ? null : +m.senderID).filter(Boolean))]
    const members = await Promise.all(senderIDs.map(x => this.getTGUser(x)))
    this.upsertParticipants(threadID, members.map(m => mapUser(m, this.accountInfo.accountID)))
  }

  getThread = async (threadID: string) => {
    const chatResponse = await this.airgram.api.getChat({ chatId: +threadID })
    return this.asyncMapThread(toObject(chatResponse))
  }

  getThreads = async (inboxName: InboxName): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    const limit = 20
    const res = await this.airgram.api.loadChats({ limit })
    const is404 = isError(res) && res.code === 404
    return {
      items: [],
      oldestCursor: '*',
      hasMore: !is404,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    const { cursor, direction } = pagination || { cursor: null, direction: null }
    const limit = 20
    const messagesResponse = await this.airgram.api.getChatHistory({
      limit,
      chatId: +threadID,
      fromMessageId: +cursor || 0,
    })
    const { messages } = toObject(messagesResponse)
    // When fromMessageId is 0, getChatHistory returns only one message.
    // See https://core.telegram.org/tdlib/getting-started#getting-chat-messages
    if (!cursor && messages.length === 1) {
      const res = await this.airgram.api.getChatHistory({
        limit,
        chatId: +threadID,
        fromMessageId: messages[0].id,
      })
      messages.push(...toObject(res).messages)
    }
    const items = mapMessages(messages, this.accountInfo.accountID).reverse()
    this.emitParticipantsFromMessages(threadID, items)
    return {
      items,
      hasMore: items.length > 0, // items.length === limit is inaccurate
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

  editMessage = async (threadID: string, messageID: string, msgContent: MessageContent) => {
    if (!msgContent.text || /^\s+$/.test(msgContent.text)) msgContent.text = '.'
    const res = await this.airgram.api.editMessageText({
      chatId: +threadID,
      messageId: +messageID,
      inputMessageContent: await getInputMessageContent(msgContent),
    })
    return !isError(toObject(res))
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
      [ActivityType.NONE]: 'chatActionCancel',
      [ActivityType.TYPING]: 'chatActionTyping',
      [ActivityType.RECORDING_VOICE]: 'ChatActionRecordingVoiceNoteInput',
      [ActivityType.RECORDING_VIDEO]: 'ChatActionRecordingVideoInput',
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

  archiveThread = async (threadID: string, archived: boolean) => {
    toObject(await this.airgram.api.addChatToList({ chatId: +threadID, chatList: { _: archived ? 'chatListArchive' : 'chatListMain' }}))
  }

  private lastChatID: number

  onThreadSelected = async (threadID: string) => {
    if (this.lastChatID) await this.airgram.api.closeChat({ chatId: this.lastChatID })
    this.lastChatID = +threadID
    if (threadID) await this.airgram.api.openChat({ chatId: +threadID })
  }

  /**
   * The frontend will request twice for each fileId, the first time for the
   * wave form, the second time for the <audio> element.
   */
  getAsset = async (type: string, fileIdStr: string) => {
    texts.log('get asset', type, fileIdStr)
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
