import path from 'path'
import bluebird from 'bluebird'
import { Airgram, Auth, ChatUnion, isError, toObject, Message as TGMessage } from 'airgram'
// import { useModels, ChatBaseModel } from '@airgram/use-models'
import { UPDATE } from '@airgram/constants'
import { PlatformAPI, OnServerEventCallback, Participant, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, AccountInfo, MessageSendOptions } from '@textshq/platform-sdk'

import { API_ID, API_HASH } from './constants'
import { mapThread, mapMessage, mapMessages } from './mappers'

const MAX_SIGNED_64BIT_NUMBER = '9223372036854775807'

export default class TelegramAPI implements PlatformAPI {
  airgram: Airgram

  private currentUser = null

  private promptCode: { resolve: (value: string) => void, reject: (reason: any) => void }

  private promptPhoneNumber: { resolve: (value: string) => void, reject: (reason: any) => void }

  init = async (session: any, { dataDirPath }: AccountInfo) => {
    this.airgram = new Airgram({
      apiId: API_ID,
      apiHash: API_HASH,
      command: path.resolve(__dirname, '../libtdjson.dylib'),
      logVerbosityLevel: texts.IS_DEV ? 2 : 0,
      useChatInfoDatabase: true,
      databaseDirectory: path.join(dataDirPath, 'db'),
      filesDirectory: path.join(dataDirPath, 'files'),
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
    this.airgram.on(UPDATE.updateNewChat, async ({ update }, next) => {
      const participants = await this._getParticipants(update.chat)
      const thread = mapThread(update.chat, participants)
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
      return next()
    })
    this.airgram.on(UPDATE.updateNewMessage, async ({ update }, next) => {
      this.handleMessageUpdate(update.message)
      return next()
    })
    this.airgram.on(UPDATE.updateMessageSendSucceeded, async ({ update }, next) => {
      // The oldMessageId is a tmp id, delete the tmp message.
      this.onEvent([
        {
          type: ServerEventType.STATE_SYNC,
          objectIDs: {
            threadID: update.message.chatId.toString(),
            messageID: update.oldMessageId.toString(),
          },
          mutationType: 'delete',
          objectName: 'message',
          entries: [update.oldMessageId.toString()],
        },
      ])
      this.handleMessageUpdate(update.message)
      return next()
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

  private getParticipant = async (userId: number): Promise<Participant> => {
    const res = await this.airgram.api.getUser({ userId })
    const user = toObject(res)
    return {
      id: user.id.toString(),
      username: user.username,
      fullName: `${user.firstName} ${user.lastName}`,
    }
  }

  private _getParticipants = async (chat: ChatUnion): Promise<Participant[]> => {
    switch (chat.type._) {
      case 'chatTypePrivate':
      case 'chatTypeSecret': {
        const participant = await this.getParticipant(chat.type.userId)
        return [participant]
      }
      case 'chatTypeBasicGroup': {
        const res = await this.airgram.api.getBasicGroupFullInfo({
          basicGroupId: chat.type.basicGroupId,
        })
        const { members } = toObject(res)
        const participants = await Promise.all(members.map(
          member => this.getParticipant(member.userId),
        ))
        return participants
      }
      case 'chatTypeSupergroup': {
        const res = await this.airgram.api.getSupergroupMembers({
          supergroupId: chat.type.supergroupId,
        })
        const { members } = toObject(res)
        const participants = await Promise.all(members.map(
          member => this.getParticipant(member.userId),
        ))
        return participants
      }
      default:
        return []
    }
  }

  getThreads = async (inboxName: InboxName, { cursor, direction }: PaginationArg = { cursor: null, direction: null }): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    const chatsResponse = await this.airgram.api.getChats({
      limit: 10,
      offsetChatId: 0,
      offsetOrder: MAX_SIGNED_64BIT_NUMBER,
    })
    const chatArr = await Promise.all(toObject(chatsResponse).chatIds.map(async chatId => {
      const chatResponse = await this.airgram.api.getChat({ chatId })
      const chat = toObject(chatResponse)
      const participants = await this._getParticipants(chat)
      return { chat, participants }
    }))
    return {
      items: chatArr.map(({ chat, participants }) => mapThread(chat, participants)),
      hasMore: false,
    }
  }

  getMessages = async (threadID: string, { cursor, direction }: PaginationArg = { cursor: null, direction: null }): Promise<Paginated<Message>> => {
    const messagesResponse = await this.airgram.api.getChatHistory({
      limit: 20,
      chatId: +threadID,
      fromMessageId: +cursor || 0,
    })
    const messages = toObject(messagesResponse).messages
    // When fromMessageId is 0, getChatHistory returns only one message.
    // See https://core.telegram.org/tdlib/getting-started#getting-chat-messages
    if (!cursor && messages.length) {
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

  sendMessage = async (threadID: string, { text }: MessageContent, { quotedMessageID }: MessageSendOptions) => {
    let content
    if (text) {
      content = {
        _: 'inputMessageText',
        text: {
          _: 'formattedText',
          text,
        },
      }
    }
    if (content) {
      await this.airgram.api.sendMessage({
        chatId: Number(threadID),
        messageThreadId: 0,
        replyToMessageId: +quotedMessageID || 0,
        inputMessageContent: content,
      })
      return true
    }
    return false
  }

  sendTypingIndicator = (threadID: string) => {}

  addReaction = async (threadID: string, messageID: string, reactionKey: string) => {}

  removeReaction = async (threadID: string, messageID: string, reactionKey: string) => {}

  deleteMessage = async (threadID: string, messageID: string) => true

  sendReadReceipt = async (threadID: string, messageID: string) => {}

  private lastChatID: number

  onThreadSelected = async (threadID: string) => {
    if (this.lastChatID) await this.airgram.api.closeChat({ chatId: this.lastChatID })
    this.lastChatID = +threadID
    if (threadID) await this.airgram.api.openChat({ chatId: +threadID })
  }
}
