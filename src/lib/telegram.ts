import bigInt from "big-integer";
import path from 'path';
import { promises as fs } from 'fs';
import { AccountInfo, MessageContent, OnServerEventCallback, texts } from "@textshq/platform-sdk";
import { CustomFile } from 'telegram/client/uploads';
import { ActivityType } from "@textshq/platform-sdk";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";

import { IsObject } from "../util";
import { mapProtoMessage } from "../mappers";
import { SEARCH_LIMIT, API_HASH as apiHash, API_ID as apiId } from "./constants";

export default class TelegramAPI {
  api: TelegramClient
  session: StringSession
  accountInfo: AccountInfo
  onEvent: OnServerEventCallback
  threads: ((Api.TypeChat | Api.TypeUser) & { messages?: Api.Message[] })[]
  topPeers: any[]

  constructor () {}

  init = async (session = '', accountInfo: AccountInfo) => {
    this.session = new StringSession(session)
    this.accountInfo = accountInfo

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

      const result = await this.api.downloadProfilePhoto(user)
      await fs.writeFile(path.join(this.accountInfo.dataDirPath, 'profile-photos', `${user?.user?.id}.jpg`), result);

      return user
    } catch (error) {
      texts.log(error)
      return null
    }
  }

  sendMessage = async (threadID: string, message: MessageContent, quotedMessageID?: string): Promise<boolean> => {
    try {
      let file = undefined;

      if (message.fileBuffer && !message.filePath) {
        const tempPath = path.join(this.accountInfo.dataDirPath, 'temp', `${threadID}_${Date.now()}`)
        await fs.writeFile(tempPath, message.fileBuffer);
        const stats = await fs.stat(tempPath)

        const toUpload = new CustomFile(message.fileName, stats.size, tempPath, message.fileBuffer);
        file = await this.api.uploadFile({ file: toUpload, workers: 10 });

        await fs.rm(tempPath)
      } else if (message.filePath) {
        const stats = await fs.stat(message.filePath)
        const toUpload = new CustomFile(message.fileName, stats.size, message.filePath);
        file = await this.api.uploadFile({ file: toUpload, workers: 10 });
      }

      await this.api.sendMessage(Number(threadID), {
        message: message.text,
        replyTo: Number(quotedMessageID) || undefined,
        file,
        thumb: file,
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

      if (IsObject.topPeersDisabled(result)) throw Error('Top peers are disabled')

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
      return null
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

  getNextChats = (): (Api.TypeChat | Api.TypeUser | Api.Channel)[] => {
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
        // TODO: MOVE THIS
        if (IsObject.userThread(chat)) {
          const result = await this.api.downloadProfilePhoto(chat)
          await fs
            .writeFile(`${this.accountInfo.dataDirPath}/profile-photos/${chat?.id}.jpg`, result)
            .catch(() => texts.log('ERROR: downloading photo'));
        } else if (IsObject.channel(chat) && chat?.photo) {
          const result = await this.api.downloadProfilePhoto(chat)
          await fs
            .writeFile(`${this.accountInfo.dataDirPath}/profile-photos/${chat?.id}.jpg`, result)
            .catch(() => texts.log('ERROR: downloading photo'));
        }
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

    const attachmentPromises = messages
      .filter(message => (message.media && IsObject.messagePhoto(message.media)) || message.document)
      .map(async message => {
        const result = await this.api.downloadMedia(message.media, {
          workers: 1,
        });
        // FIXME: Move this and maybe download in background (using getAsset). This will
        // stop messaging loading instead of loading in parallel
        // @ts-expect-error
        message.media?.data = result
      })

    await Promise.all(attachmentPromises)

    // FIXME: Update threads participants
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

    return IsObject.userThread(thread)
      ? new Api.InputPeerUser({ userId: Number(threadID), accessHash: thread.accessHash })
      : new Api.InputPeerChat({ chatId: Number(threadID) })
  }

  editMessage = async (threadID: string, messageID: string, messageContent: MessageContent): Promise<boolean> => {
    try {
      const peer = this._getPeer(threadID)

      let file = undefined;

      if (messageContent.fileBuffer && !messageContent.filePath) {
        const tempPath = path.join(this.accountInfo.dataDirPath, 'temp', `${threadID}_${Date.now()}`)
        await fs.writeFile(tempPath, messageContent.fileBuffer);
        const stats = await fs.stat(tempPath)

        const toUpload = new CustomFile(messageContent.fileName, stats.size, tempPath, messageContent.fileBuffer);
        file = await this.api.uploadFile({ file: toUpload, workers: 10 });

        await fs.rm(tempPath)
      } else if (messageContent.filePath) {
        const stats = await fs.stat(messageContent.filePath)
        const toUpload = new CustomFile(messageContent.fileName, stats.size, messageContent.filePath);
        file = await this.api.uploadFile({ file: toUpload, workers: 10 });
      }

      await this.api.invoke(new Api.messages.EditMessage({
        id: Number(messageID),
        message: messageContent.text,
        peer,
        media: new Api.InputMediaDocument({ id: file.id }),
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
