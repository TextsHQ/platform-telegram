import { MessageContent, OnServerEventCallback, texts } from "@textshq/platform-sdk";
import { ActivityType } from "@textshq/platform-sdk";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import bigInt from "big-integer";

import { isUserThread, mapProtoMessage } from "../mappers";
import { SEARCH_LIMIT, API_HASH as apiHash, API_ID as apiId } from "./constants";

export default class TelegramAPI {
  api: TelegramClient
  session: StringSession
  onEvent: OnServerEventCallback
  threads: ((Api.TypeChat | Api.TypeUser) & { messages?: Api.Message[] })[]
  topPeers: any[]

  constructor () {}

  init = async (session = '') => {
    this.session = new StringSession(session)

    this.api = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
    });

    if (session) await this.api.connect();
  }

  getSessionSerialized = () => this.session.save()

  setOnEvent = (callback: OnServerEventCallback) => this.onEvent = callback

  logout = async (): Promise<void> => {
    await this.api.invoke(new Api.auth.LogOut());
  }

  getPhoneCodeHash = async (phoneNumber: string): Promise<string> => {
    await this.api.connect()

    const res = await this.api.invoke(
      new Api.auth.SendCode({
        phoneNumber,
        apiHash,
        apiId,
        settings: new Api.CodeSettings({
          allowFlashcall: true,
          currentNumber: true,
          allowAppHash: true,
        }),
      })
    );

    return res?.phoneCodeHash
  }

  login = async ({ code, phone, password = undefined }: { code: string; phone: string; password?: string }) => {
    const signInResult = await this.api.start({
      phoneNumber: phone,
      phoneCode: async () => code,
      password: password ? async () => password : undefined,
      onError: (err) => {
        throw new Error(err.message)
      }
    });

    return signInResult
  }

  register = async (credentials: {
    code: string;
    phone: string;
    codeHash: string;
    firstName: string;
    lastName: string;
  }) => {
    return null
  }

  getCurrentUser = async (): Promise<Api.UserFull> => {
    try {
      const user = await this.api.invoke(
        new Api.users.GetFullUser({ id: new Api.InputUserSelf() })
      );

      return user
    } catch (error) {
      texts.log(error)
      return null
    }
  }

  sendMessage = async (threadID: string, message: MessageContent): Promise<boolean> => {
    try {
      const res = await this.api.sendMessage(Number(threadID), {
        // FIXME: Support files
        message: message.text,
      })

      return true
    } catch (error) {
      texts.error(error)
      return false
    }
  }

  getTopPeers = async (): Promise<any[]> => {
    try {
      const result = await this.api.invoke(
        new Api.contacts.GetTopPeers({
          correspondents: true,
          botsPm: true,
          botsInline: true,
          phoneCalls: true,
          forwardUsers: true,
          forwardChats: true,
          groups: true,
          channels: true,
        })
      );

      // @ts-expect-error
      const topPeers = [...result.users, ...result.chats]

      for (const top of topPeers) {
        const messages = await this.api.getMessages(Number(top.id), { limit: 1 })
        // @ts-expect-error
        top.messages = messages.map(mapProtoMessage)
      }

      this.topPeers = topPeers
      return topPeers
    } catch (error) {
      texts.error(error)
      this.topPeers = []
      return []
    }
  }

  getUserInfo = async (userId: number): Promise<Api.UserFull> => {
    const info = await this.api.invoke(
      new Api.users.GetFullUser({
        id: userId,
      })
    );

    return info
  }

  getParticipants = async (entity: Api.Chat | Api.Channel): Promise<Api.User[]> => {
    const participants = await this.api.getParticipants(entity, {})
    return participants
  }

  getContacts = async (): Promise<void> => {
    // @ts-expect-error
    const res: Api.contacts.Contacts = await this.api.invoke(new Api.contacts.GetContacts({}));
    this.threads = [...(this.threads || []), ...res?.users]
  }

  getChats = async (): Promise<void> => {
    const res = await this.api.invoke(new Api.messages.GetAllChats({ exceptIds: [] }))
    this.threads = [...(this.threads || []), ...res?.chats]
  }

  getNextChats = (): (Api.TypeChat | Api.TypeUser)[] => {
    const nextChats = this.threads?.filter((chat) => !chat.messages).slice(0, 5)
    return [...(nextChats || [])]
  }

  getThreads = async (): Promise<(Api.TypeChat | Api.TypeUser)[]> => {
    try {
      if (!this.threads) {
        await this.getChats()
        await this.getContacts()
      }

      const next = this.getNextChats()
      // FIXME: this isn't the best way to handle this, this should be better handled
      for (const chat of next) {
        const messages = await this.api.getMessages(Number(chat.id), { limit: 1 })
        const thread = this.threads.find((thread) => thread.id === chat.id)
        // @ts-expect-error
        thread.messages = messages.map(mapProtoMessage) || []
        // @ts-expect-error
        chat.messages = messages.map(mapProtoMessage) || []
      }

      return next
    } catch (error) {
      texts.error(error)
      return null
    }
  }

  getMessages = async (id: string, offsetId: number): Promise<Api.Message[]> => {
    const messages = await this.api.getMessages(Number(id), {
      limit: 20,
      offsetId,
      maxId: offsetId,
    });

    // for (const message of messages) {
    //   // @ts-expect-error
    //   const { user } = await this.getUserInfo(message.fromId.userId)
    //   const participant = mapParticipant(user)

    //   this.onEvent([{
    //     type: ServerEventType.STATE_SYNC,
    //     mutationType: 'upsert',
    //     objectName: 'participant',
    //     objectIDs: { threadID: id },
    //     entries: [participant],
    //   }])
    // }

    // @ts-expect-error
    return messages.sort((a, b) => a.date - b.date)
  }

  _getPeer = (threadID: string) => {
    const thread = this.threads?.find((t) => t.id === Number(threadID))
    if (!thread) return

    return isUserThread(thread)
      ? new Api.InputPeerUser({ userId: Number(threadID), accessHash: thread.accessHash })
      : new Api.InputPeerChat({ chatId: Number(threadID) })
  }

  editMessage = async (threadID: string, messageID: string, messageContent: MessageContent): Promise<boolean> => {
    try {
      const peer = this._getPeer(threadID)

      await this.api.invoke(new Api.messages.EditMessage({
        id: Number(messageID),
        message: messageContent.text,
        peer
        // FIXME: Support media
        // noWebpage: true,
        // media: new Api.InputMedia({...}),
        // replyMarkup: new Api.ReplyMarkup({...}),
        // entities: [new Api.MessageEntity({...})],
        // scheduleDate: 1557612,
      }));

      return true
    } catch (error) {
      texts.error(error)
      return false
    }
  }

  sendTypingIndicator = async (activityAction: ActivityType, threadID: string): Promise<void> => {
    const action = {
      [ActivityType.TYPING]: new Api.SendMessageTypingAction(),
    }[activityAction]

    if (!action) return

    const peer = this._getPeer(threadID)

    await this.api.invoke(new Api.messages.SetTyping({
      topMsgId: Number(threadID),
      peer,
      action,
    }));
  }

  markAsUnread = async (threadID: string) => {
    const peer = this._getPeer(threadID)

    await this.api.invoke(new Api.messages.MarkDialogUnread({
      unread: true,
      peer: new Api.InputDialogPeer({ peer }),
    }));
  }

  deleteMessage = async (messageID: string, forEveryone: boolean): Promise<boolean> => {
    try {
      await this.api.invoke(new Api.messages.DeleteMessages({
        revoke: forEveryone,
        id: [Number(messageID)],
      }));

      return true
    } catch (error) {
      texts.error(error)
      return false
    }
  }

  sendReadReceipt = async (threadID: string, messageID: string): Promise<boolean> => {
    try {
      const peer = this._getPeer(threadID)

      await this.api.invoke(new Api.messages.ReadHistory({
        maxId: Number(messageID),
        peer,
      }));

      return true
    } catch (error) {
      return false
    }
  }

  searchContacts = async (q: string): Promise<any[]> => {
    const res = await this.api.invoke(new Api.contacts.Search({
      q,
      limit: SEARCH_LIMIT,
    }));

    return res.users
  }

  createThread = async (userIDs: string[], title?: string) => {
    // TODO: Move this
    // @ts-expect-error
    const getAccessHash = id => this.threads.find((thread => thread.id === Number(id)))?.accessHash

    const users = userIDs.map(id => new Api.InputUser({
      userId: Number(id),
      accessHash: getAccessHash(id)
    }))

    const res = await this.api.invoke(new Api.messages.CreateChat({
      users,
      title,
    }));
    // @ts-expect-error
    return res?.chats
  }

  forwardMessage = async (fromThreadID: string, messageID: string, toThreadID: string): Promise<boolean> => {
    try {
      const fromPeer = this._getPeer(fromThreadID)
      const toPeer = this._getPeer(toThreadID)

      await this.api.invoke(new Api.messages.ForwardMessages({
        silent: true,
        background: true,
        withMyScore: true,
        fromPeer,
        toPeer,
        id: [Number(messageID)],
        randomId: [bigInt(messageID)],
      }));

      return true
    } catch (error) {
      texts.error(error)
      return false
    }
  }

  deleteThreadHistory = async (threadID: string): Promise<void> => {
    const peer = this._getPeer(threadID)

    await this.api.invoke(new Api.messages.DeleteHistory({
      justClear: true,
      revoke: true,
      peer,
    }));
  }
}
