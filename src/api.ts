import path from 'path'
import bluebird from 'bluebird'
import { Airgram, Auth, ChatUnion, isError, toObject, Message as TGMessage } from 'airgram'
// import { useModels, ChatBaseModel } from '@airgram/use-models'
import { UPDATE } from '@airgram/constants'
import { PlatformAPI, OnServerEventCallback, Participant, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, AccountInfo, MessageSendOptions } from '@textshq/platform-sdk'

import { API_ID, API_HASH } from './constants'
import { mapThread, mapMessage, mapMessages, mapUser } from './mappers'

const MAX_SIGNED_64BIT_NUMBER = '9223372036854775807'

export default class TelegramAPI implements PlatformAPI {
  airgram: Airgram

  private accountInfo: AccountInfo

  private currentUser = null

  private promptCode: { resolve: (value: string) => void, reject: (reason: any) => void }

  private promptPhoneNumber: { resolve: (value: string) => void, reject: (reason: any) => void }

  private getThreadsDone = false

  private pendingMessages: {[key: number]: Function} = {}

  private pendingFiles: {[key: number]: Function} = {}

  init = async (session: any, accountInfo: AccountInfo) => {
    this.accountInfo = accountInfo
    this.airgram = new Airgram({
      apiId: API_ID,
      apiHash: API_HASH,
      command: path.resolve(__dirname, '../libtdjson.dylib'),
      logVerbosityLevel: texts.IS_DEV ? 2 : 0,
      useChatInfoDatabase: true,
      databaseDirectory: path.join(accountInfo.dataDirPath, 'db'),
      filesDirectory: path.join(accountInfo.dataDirPath, 'files'),
      // eslint-disable-next-line react-hooks/rules-of-hooks
      // models: useModels({
      //   chat: ChatBaseModel,
      // }),
    })

    this.airgram.use(new Auth({
      code: () => new Promise((resolve, reject) => {
        this.promptCode = { resolve, reject }
      }),
      phoneNumber: () => new Promise((resolve, reject) => {
        this.promptPhoneNumber = { resolve, reject }
      }),
    }))

    if (session) {
      this.afterLogin()
    }
    // airgram.use((ctx, next) => {
    //   if ('update' in ctx) {
    //     console.log(`[all updates][${ctx._}]`, JSON.stringify(ctx.update))
    //   }
    //   return next()
    // })
  }

  private state = 'phone'

  login = async (creds: LoginCreds): Promise<LoginResult> => {
    const { phoneNumber, code } = creds.custom
    if (this.state === 'phone') {
      this.promptPhoneNumber.resolve(phoneNumber)
      this.state = 'code'
      return { type: 'code_required' }
    }
    if (this.state === 'code') {
      this.promptCode.resolve(code)
      this.afterLogin()
      return { type: 'success' }
    }
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
        messageID: message.id,
      },
      entries: [message],
    }
    this.onEvent([event])
  }

  private afterLogin = () => {
    this.airgram.on(UPDATE.updateNewChat, async ({ update }) => {
      if (!this.getThreadsDone) {
        // Existing threads will be handled by getThreads, no need to duplicate
        // here. And update.chat.lastMessage seems to be always null, which will
        // mess up thread timestamp.
        return
      }
      const participants = await this._getParticipants(update.chat)
      const thread = mapThread(update.chat, participants, this.accountInfo.accountID)
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
    this.airgram.on(UPDATE.updateNewMessage, async ({ update }) => {
      this.handleMessageUpdate(update.message)
    })
    this.airgram.on(UPDATE.updateMessageSendSucceeded, async ({ update }) => {
      if (this.pendingMessages[update.oldMessageId]) {
        this.pendingMessages[update.oldMessageId](true)
        delete this.pendingMessages[update.oldMessageId]
      }
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
            durationMs: 3000,
          }])
        }
        default:
      }
    })
    this.airgram.on(UPDATE.updateFile, async ({ update }) => {
      if (update.file.local.isDownloadingCompleted && update.file.local.path && this.pendingFiles[update.file.id]) {
        this.pendingFiles[update.file.id](`file://${update.file.local.path}`)
        delete this.pendingFiles[update.file.id]
      }
    })
  }

  logout = () => {

  }

  dispose = () =>
    this.airgram?.destroy()

  getCurrentUser = async (): Promise<CurrentUser> => {
    const me = await this.airgram.api.getMe()
    const user = toObject(me)
    this.currentUser = user
    return {
      id: String(user.id),
      displayText: user.username,
    }
  }

  private onEvent: OnServerEventCallback = () => {}

  subscribeToEvents = (onEvent: OnServerEventCallback) => {
    this.onEvent = onEvent
  }

  serializeSession = () => true

  searchUsers = async (typed: string) => []

  createThread = (userIDs: string[]) => null

  private getUser = async (userId: number) => {
    const res = await this.airgram.api.getUser({ userId })
    const user = toObject(res)
    return mapUser(user, this.accountInfo.accountID)
  }

  private _getParticipants = async (chat: ChatUnion): Promise<Participant[]> => {
    switch (chat.type._) {
      case 'chatTypePrivate':
      case 'chatTypeSecret': {
        const participant = await this.getUser(chat.type.userId)
        return [participant]
      }
      case 'chatTypeBasicGroup': {
        const res = await this.airgram.api.getBasicGroupFullInfo({ basicGroupId: chat.type.basicGroupId })
        const { members } = toObject(res)
        const participants = await Promise.all(members.map(
          member => this.getUser(member.userId),
        ))
        return participants
      }
      case 'chatTypeSupergroup': {
        const supergroupRes = await this.airgram.api.getSupergroupFullInfo({ supergroupId: chat.type.supergroupId })
        const supergroup = toObject(supergroupRes)
        if (!supergroup.canGetMembers) {
          return []
        }
        return []
        // const membersResponse = await this.airgram.api.getSupergroupMembers({
        //   supergroupId: chat.id,
        //   limit: 100,
        // })
        // const { members } = toObject(membersResponse)
        // const participants = await Promise.all(members.map(member => this.getParticipant(member.userId)))
        // return participants
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
      offsetOrder: MAX_SIGNED_64BIT_NUMBER,
    })
    const { chatIds } = toObject(chatsResponse)
    const items = await Promise.all(chatIds.map(async chatId => {
      const chatResponse = await this.airgram.api.getChat({ chatId })
      const chat = toObject(chatResponse)
      const participants = await this._getParticipants(chat)
      return mapThread(chat, participants, this.accountInfo.accountID)
    }))
    this.getThreadsDone = true
    return {
      items,
      oldestCursor: items[items.length - 1]?.id,
      hasMore: items.length === limit,
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
      const messagesResponse = await this.airgram.api.getChatHistory({
        limit: 20,
        chatId: +threadID,
        fromMessageId: messages[0].id,
      })
      messages.push(...toObject(messagesResponse).messages)
    }
    return {
      items: mapMessages(messages).reverse(),
      hasMore: messages.length >= 20,
    }
  }

  sendMessage = async (threadID: string, { text, filePath, mimeType }: MessageContent, { quotedMessageID }: MessageSendOptions) : Promise<boolean> => {
    let content
    if (text) {
      content = {
        _: 'inputMessageText',
        text: {
          _: 'formattedText',
          text,
        },
      }
    } else if (filePath) {
      const fileInput = {
        _: 'inputFileLocal',
        path: filePath,
      }
      switch (mimeType.split('/')[0]) {
        case 'image':
          content = {
            _: 'inputMessagePhoto',
            photo: fileInput,
          }
          break
        case 'audio':
          content = {
            _: 'inputMessageAudio',
            audio: fileInput,
          }
          break
        case 'video':
          content = {
            _: 'inputMessageVideo',
            video: fileInput,
          }
          break
        default:
          content = {
            _: 'inputMessageDocument',
            document: fileInput,
          }
          break
      }
    }
    if (content) {
      const res = await this.airgram.api.sendMessage({
        chatId: Number(threadID),
        messageThreadId: 0,
        replyToMessageId: +quotedMessageID || 0,
        inputMessageContent: content,
      })
      return new Promise(resolve => {
        const tmpId = toObject(res).id
        this.pendingMessages[tmpId] = resolve
      })
    }
    return false
  }

  sendTypingIndicator = (threadID: string, typing: boolean) => {
    if (!typing) return
    this.airgram.api.sendChatAction({
      chatId: +threadID,
      messageThreadId: 0,
      action: {
        _: 'chatActionTyping',
      },
    })
  }

  deleteMessage = async (threadID: string, messageID: string, forEveryone: boolean) => {
    const res = await this.airgram.api.deleteMessages({
      chatId: +threadID,
      messageIds: [+messageID],
      revoke: forEveryone,
    })
    return toObject(res)._ === 'ok'
  }

  sendReadReceipt = async (threadID: string, messageID: string) => {}

  private lastChatID: number

  onThreadSelected = async (threadID: string) => {
    if (this.lastChatID) await this.airgram.api.closeChat({ chatId: this.lastChatID })
    this.lastChatID = +threadID
    if (threadID) await this.airgram.api.openChat({ chatId: +threadID })
  }

  getAsset = async (type: string, fileIdStr: string) => {
    if (type !== 'file') throw new Error('unknown asset type')
    const fileId = +fileIdStr
    await this.airgram.api.downloadFile({
      fileId,
      priority: 32,
    })
    return new Promise<string>(resolve => {
      this.pendingFiles[fileId] = resolve
    })
  }
}
