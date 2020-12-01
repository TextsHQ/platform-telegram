import path from 'path'
import bluebird from 'bluebird'
import { Airgram, Auth, isError, toObject } from 'airgram'
// import { useModels, ChatBaseModel } from '@airgram/use-models'
import { UPDATE } from '@airgram/constants'
import { PlatformAPI, OnServerEventCallback, Participant, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, AccountInfo } from '@textshq/platform-sdk'

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

  private afterLogin = () => {
    this.airgram.on(UPDATE.updateNewChat, async ({ update }, next) => {
      // const chatMemberResponse = await this.airgram.api.getChatMember({ chatId: update.chat.id })
      // const groupResponse = await this.airgram.api.getBasicGroupFullInfo({ basicGroupId: update.chat.id })
      // const groupMembers = await this.airgram.api.getSupergroupMembers({ supergroupId: update.chat.id })
      // const member = toObject(chatMemberResponse)
      // const user = await this.airgram.api.getUser({ userId: member.userId })
      const thread = mapThread(update.chat, [])
      const event: ServerEvent = {
        type: ServerEventType.STATE_SYNC,
        mutationType: 'upsert',
        objectName: 'thread',
        objectIDs: {
          threadID: thread.id
        },
        entries: [thread],
      }
      this.onEvent([event])
      return next()
    })
    this.airgram.on(UPDATE.updateNewMessage, async ({update},next) => {
      const message = mapMessage(update.message)
      const event: ServerEvent = {
        type: ServerEventType.STATE_SYNC,
        mutationType: 'upsert',
        objectName: 'message',
        objectIDs: {
          threadID: update.message.chatId.toString(),
          messageID: message.id
        },
        entries: [message],
      }
      this.onEvent([event])
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

  getThreads = async (inboxName: InboxName, { cursor, direction }: PaginationArg = { cursor: null, direction: null }): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    const chatsResponse = await this.airgram.api.getChats({
      limit: 10,
      offsetChatId: 0,
      offsetOrder: MAX_SIGNED_64BIT_NUMBER,
    })
    const chatArr = await Promise.all(toObject(chatsResponse).chatIds.map(async chatId => {
      const chatResponse = await this.airgram.api.getChat({ chatId })
      return toObject(chatResponse)
    }))
    return {
      items: chatArr.map(chat => mapThread(chat, [])),
      hasMore: false,
    }
  }

  getMessages = async (threadID: string, { cursor, direction }: PaginationArg = { cursor: null, direction: null }): Promise<Paginated<Message>> => {
    const messagesResponse = await this.airgram.api.getChatHistory({
      limit: 20,
      chatId: +threadID,
      fromMessageId: +cursor || 0,
    })
    const messages = toObject(messagesResponse)
    return {
      items: mapMessages(messages.messages).reverse(),
      hasMore: messages.messages.length === 20,
    }
  }

  sendMessage = async (threadID: string, { text }: MessageContent) => {
    let content
    if (text) {
      content = {
        _: "inputMessageText",
        text: {
          _: "formattedText",
          text
        }
      }
    }
    if (content) {
      await this.airgram.api.sendMessage({
        chatId: Number(threadID),
        messageThreadId: 0,
        inputMessageContent: content
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
