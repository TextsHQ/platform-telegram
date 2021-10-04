// this should be the first import to fix PATH env variable on windows
// eslint-disable-next-line
import { copyDLLsForWindows, IS_WINDOWS } from './windows'
import type { Api } from 'telegram'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import rimraf from 'rimraf'
import type MTProto from '@mtproto/core'
import { Airgram, ChatUnion, Message as TGMessage, FormattedTextInput, InputMessageContentInputUnion, InputMessageTextInput, InputFileInputUnion, isError, ChatMember, Chat, AuthorizationStateUnion, TDLibError, ApiResponse, BaseTdObject, User as TGUser } from 'airgram'
import { AUTHORIZATION_STATE, CHAT_MEMBER_STATUS, SECRET_CHAT_STATE, UPDATE } from '@airgram/constants'
import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, AccountInfo, MessageSendOptions, ActivityType, ReAuthError, OnConnStateChangeCallback, ConnectionStatus, StateSyncEvent, Participant } from '@textshq/platform-sdk'

import { API_ID, API_HASH, BINARIES_DIR_PATH, MUTED_FOREVER_CONSTANT } from './constants'
import { mapThread, mapMessage, mapMessages, mapUser, mapUserPresence, mapMuteFor, getMessageButtons, mapTextFooter, mapMessageUpdateText, mapUserAction, mapCurrentUser, mapProtoThread, mapProtoMessage } from './mappers'
import { fileExists } from './util'
import TelegramAPI from './lib/telegram'

type SendMessageResolveFunction = (value: Message[]) => void
type GetAssetResolveFunction = (value: string) => void
type Session = { client: MTProto }
type LoginEventCallback = (authState: any) => void

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
  darwin: `${process.arch}_libtdjson.dylib`,
  linux: `${process.arch}_libtdjson.so`,
  win32: `${process.arch}_libtdjson.dll`,
}[process.platform])

export default class Telegram implements PlatformAPI {
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

  private api: TelegramAPI = new TelegramAPI()

  private currentUser: Api.TypeUserFull = null

  private loginMetadata: Record<string, any> = { state: 'authorizationStateWaitPhoneNumber' }

  init = async (data: { session: string }, accountInfo: AccountInfo) => {
    const { session } = data || {}

    await this.api.init(session || '')
    if (session) await this.afterAuth()
  }

  getCurrentUser = () => mapCurrentUser(this.currentUser)

  // FIXME: try to find a way to serialize this
  serializeSession = () => ({ session: this.api.getSessionSerialized() })

  onLoginEvent = (onEvent: LoginEventCallback) => {
    this.loginEventCallback = onEvent
    this.loginEventCallback(this.loginMetadata.state)
  }

  onConnectionStateChange = (onEvent: OnConnStateChangeCallback) => {
    this.connStateChangeCallback = onEvent
  }

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
      return { type: 'error', errorMessage: 'Error.' }
    } catch (error) {
      console.log(error)
      return { type: 'error', errorMessage: 'Error.' }
    }
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
      objectIDs: {
        threadID,
      },
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

  logout = async () => {
    await this.api.logout()
  }

  dispose = async () => {}

  private onEvent: OnServerEventCallback = () => {}

  subscribeToEvents = (onEvent: OnServerEventCallback) => {
    this.onEvent = onEvent
    this.api.setOnEvent(onEvent)
  }

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
    const mapMembers = (members: ChatMember[]) => Promise.all(members.map(member => this.getTGUser(member.userId)))
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

  private loadChats = async (chatIds: number[]) => {
    const chats = await Promise.all(chatIds.map(async chatId => {
      const chatResponse = await this.airgram.api.getChat({ chatId })
      return toObject(chatResponse)
    }))
    return chats
  }

  getThread = async (threadID: string) => {
    const chatResponse = await this.airgram.api.getChat({ chatId: +threadID })
    return this.asyncMapThread(toObject(chatResponse))
  }

  getThreads = async (inboxName: InboxName, pagination: PaginationArg): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    // This is added to speed up the initial load.
    if (!this.api.topPeers) {
      const topPeers = await this.api.getTopPeers()
      const items = topPeers.map(mapProtoThread)

      return { items, hasMore: true }
    }

    const threads = await this.api.getThreads()
    const items = threads.map(mapProtoThread)

    return {
      items,
      hasMore: items.length > 0,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    const { cursor } = pagination || { cursor: null, direction: null }
    
    const messages = await this.api.getMessages(threadID, Number(cursor))
    const oldestCursor = String(messages[0]?.id)
    
    const items = messages.map(mapProtoMessage)

    return {
      items,
      oldestCursor,
      hasMore: items.length > 0,
    }
  }

  sendMessage = async (threadID: string, msgContent: MessageContent, { quotedMessageID }: MessageSendOptions) => {
    const res = await this.api.sendMessage(threadID, msgContent)
    return res
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
