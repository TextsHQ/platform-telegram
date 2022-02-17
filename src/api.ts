/* eslint-disable @typescript-eslint/no-throw-literal */
// eslint-disable-next-line

import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, MessageSendOptions, ActivityType, ReAuthError, StateSyncEvent, Participant, AccountInfo, User } from '@textshq/platform-sdk'
import { debounce } from 'lodash'
import { TelegramClient } from 'telegram'
import { NewMessage, NewMessageEvent } from 'telegram/events'
import { Api } from 'telegram/tl'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { SendMessageParams } from 'telegram/client/messages'
import { CustomFile } from 'telegram/client/uploads'
import path from 'path'
import fs from 'fs/promises'
import url from 'url'
import { getPeerId } from 'telegram/Utils'
import type { CustomMessage } from 'telegram/tl/custom/message'
import BigInteger from 'big-integer'
import type bigInt from 'big-integer'
import { randomBytes } from 'crypto'
import os from 'os'
import { Airgram } from 'airgram'
import dns from 'dns/promises'
import { API_ID, API_HASH, REACTIONS, MUTED_FOREVER_CONSTANT, BINARIES_DIR_PATH } from './constants'
import TelegramMapper from './mappers'
import { fileExists, stringifyCircular } from './util'
import { DbSession } from './dbSession'

type LoginEventCallback = (authState: any) => void
type AirgramSession = { dbKey: string }

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
    const buffer = await fs.readFile(filePath)
    return new CustomFile(fileName, buffer.byteLength, filePath, buffer)
  } if (fileBuffer) {
    return new CustomFile(fileName, fileBuffer.length, filePath, fileBuffer)
  }
}
const isAirgramSession = (session: string | AirgramSession): session is AirgramSession =>
  !!(session as AirgramSession)?.dbKey

const tdlibPath = path.join(BINARIES_DIR_PATH, {
  darwin: `${process.platform}-${process.arch}/libtdjson.dylib`,
  linux: `${process.platform}-${process.arch}/libtdjson.so`,
  win32: `${process.platform}-${process.arch}/libtdjson.dll`,
}[process.platform])

interface LoginInfo {
  phoneNumber?: string
  phoneCodeHash?: string
  phoneCode?: string
  password?: string
}
export default class TelegramAPI implements PlatformAPI {
  private client: TelegramClient

  private authState: AuthState

  private accountInfo: AccountInfo

  private loginEventCallback: LoginEventCallback

  private dbSession: DbSession

  private dialogs: Map<string, Dialog> = new Map<string, Dialog>()

  private messageMediaStore = new Map<number, Api.TypeMessageMedia>()

  private chatIdMessageId = new Map<bigInt.BigInteger, number[]>()

  private dialogToParticipantIds = new Map<bigInt.BigInteger, Set<bigInt.BigInteger>>()

  private me: Api.User

  private meMapped: User

  private mapper: TelegramMapper

  private sessionName: string

  private airgramConn: Airgram

  private loginInfo: LoginInfo = {}

  init = async (session: string | AirgramSession | undefined, accountInfo: AccountInfo) => {
    if (isAirgramSession(session)) {
      try {
        this.airgramConn = new Airgram({
          databaseEncryptionKey: session.dbKey,
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
        texts.log('Waiting..')
        const authPromise = new Promise<void>((resolve, reject) => {
          this.airgramConn?.on('updateAuthorizationState', ({ update }) => {
            if (update.authorizationState._ === 'authorizationStateReady') {
              resolve()
            } else if (update.authorizationState._ === 'authorizationStateClosed') reject()
          })
        })
        await authPromise
        texts.log('Done auth')
        this.sessionName = randomBytes(8).toString('hex')
      } catch (err) {
        throw new Error()
      }
    } else {
      this.sessionName = session || randomBytes(8).toString('hex')
    }

    const dbPath = path.join(accountInfo.dataDirPath, this.sessionName) + '.sqlite'
    this.dbSession = new DbSession({
      dbPath,
    })

    this.accountInfo = accountInfo

    await this.dbSession.init()

    this.client = new TelegramClient(this.dbSession, API_ID, API_HASH, {
      connectionRetries: 3,
      maxConcurrentDownloads: 2,
    })

    this.accountInfo = accountInfo
    await this.client.connect()
    this.connectionWatchDog(30)

    if (this.airgramConn) {
      await this.doMigration()
      this.onEvent([{
        type: ServerEventType.TOAST,
        toast: {
          text: 'Your Telegram account login session was migrated and you may see a new login notification.',
        },
      }])
    }
    this.authState = AuthState.PHONE_INPUT

    if (session) await this.afterLogin()
  }

  private doMigration = async () => {
    try {
      const qrToken = await this.client.invoke(new Api.auth.ExportLoginToken({
        apiId: API_ID,
        apiHash: API_HASH,
        exceptIds: [],
      }))
      if (qrToken) {
        texts.log(JSON.stringify(qrToken, null, 4))
        if (qrToken.className === 'auth.LoginToken') {
          const token = `tg://login?token=${qrToken.token.toString('base64url')}`
          const confirmResult = await this.airgramConn.api.confirmQrCodeAuthentication({ link: token })
          texts.log(JSON.stringify(confirmResult, null, 4))
          const qrTokenResult = await this.client.invoke(new Api.auth.ExportLoginToken({
            apiId: API_ID,
            apiHash: API_HASH,
            exceptIds: [],
          }))
          texts.log(JSON.stringify(qrTokenResult, null, 4))
          if (qrTokenResult.className === 'auth.LoginTokenSuccess') {
            texts.log('token success')
            await this.airgramConn.destroy()
            this.dbSession.save()
            return
          }
          if (qrTokenResult.className === 'auth.LoginTokenMigrateTo') {
            texts.log('migrating DC')
            await this.client._switchDC(qrTokenResult.dcId)
            const migratedToken = await this.client.invoke(new Api.auth.ImportLoginToken({
              token: qrTokenResult.token }))
            if (migratedToken.className === 'auth.LoginTokenSuccess') {
              texts.log('token success')
              await this.airgramConn.destroy()
              this.dbSession.save()
              return
            }
          }
        }
      }
    } catch (e) {
      throw new ReAuthError()
    }
    throw new ReAuthError()
  }

  private connectionWatchDog = async (intervalSeconds: number) => {
    const delay = async (ms: number) => new Promise(resolve => { setTimeout(resolve, ms) })
    await delay(60_000)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await delay(intervalSeconds * 1000)
      await (async () => {
        if (!this.client._sender?.isConnected() && !this.client._sender.isConnecting) {
          texts.log('Attempting reconnection')
          try {
            await dns.resolve('www.google.com')
            await this.client.connect()
            texts.log('Reconnected client.')
          } catch (e) {
            texts.log('Couldn\'t reconnect client')
          }
        }
      })()
    }
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

    if (IS_DEV) console.log('CREDS_CUSTOM', JSON.stringify(creds.custom, null, 4))
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
            password: async () => this.loginInfo.password ?? '',
            onError: async err => { console.log(`Auth error ${err}`); return true },
          })
          this.authState = AuthState.READY
          break
        }
        case AuthState.READY:
        {
          if (IS_DEV) console.log('READY')
          this.dbSession.save()
          await this.afterLogin()
          return { type: 'success' }
        }
        default:
        {
          if (IS_DEV) console.log(`Auth state is ${this.authState}`)
          return { type: 'error' }
        }
      }
    } catch (e) {
      texts.log('err', e, JSON.stringify(e, null, 4))
      texts.Sentry.captureException(e)
      if (e.code === 401) this.authState = AuthState.PASSWORD_INPUT
      else return { type: 'error', errorMessage: mapError(e.errorMessage) }
    }

    this.loginEventCallback(this.authState)
    return { type: 'wait' }
  }

  private storeMessage(message: CustomMessage) {
    if (message.media) {
      this.messageMediaStore.set(message.id, message.media)
    }
    if (!message.chatId) return
    const thread = this.chatIdMessageId.get(message.chatId)
    if (thread) {
      thread.push(message.id)
    } else {
      this.chatIdMessageId.set(message.chatId, [message.id])
    }
  }

  private onUpdateNewMessage = async (newMessageEvent: NewMessageEvent) => {
    const { message } = newMessageEvent
    if (!message.chatId) return
    if (!message.senderId) return
    const threadID = message.chatId.toString()
    const mappedMessage = this.mapper.mapMessage(message)
    this.emitParticipantFromMessage(message.chatId, message.senderId)
    if (!mappedMessage) return
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'message',
      objectIDs: { threadID },
      entries: [mappedMessage],
    }
    this.storeMessage(message)
    this.onEvent([event])
  }

  private mapThread = (dialog: Dialog) => {
    const thread = this.mapper.mapThread(dialog)
    this.emitParticipants(dialog)
    return thread
  }

  private emitThread = async (thread: Thread) => {
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
      const chatId = update.chatId.toString()
      this.emitDeleteThread(chatId)
    }
    if (update.newParticipant) this.emitParticipantFromMessage(update.chatId, update.userId)
  }

  private onUpdateChannelParticipant(update: Api.UpdateChannelParticipant) {
    if (update.prevParticipant) {
      const chatId = update.channelId.toString()
      this.emitDeleteThread(chatId)
    }
    if (update.newParticipant) this.emitParticipantFromMessage(update.channelId, update.userId)
  }

  private onUpdateNotifySettings(update: Api.UpdateNotifySettings) {
    if (!('peer' in update.peer)) return
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      objectIDs: {},
      mutationType: 'update',
      objectName: 'thread',
      entries: [{
        id: getPeerId(update.peer.peer).toString(),
        mutedUntil: new Date(update.notifySettings.muteUntil ?? 0),
      }],
    }])
  }

  private onUpdateDeleteMessages(update: Api.UpdateDeleteMessages) {
    if (!update.messages?.length) return
    const threadID = Array.from(this.chatIdMessageId.entries()).find(thread => thread[1].find(message => message === update.messages[0]))
    if (!threadID) return
    this.onEvent([
      {
        type: ServerEventType.STATE_SYNC,
        objectIDs: {
          threadID: threadID[0].toString(),
        },
        mutationType: 'delete',
        objectName: 'message',
        entries: update.messages.map(id => id.toString()),
      },
    ])
  }

  private onUpdateUserTyping(update: Api.UpdateUserTyping) {
    const event = TelegramMapper.mapUserAction(update)
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

  private onUpdateReadHistoryInbox(update: Api.UpdateReadHistoryInbox) {
    const threadID = getPeerId(update.peer)
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

  private onUpdateReadHistoryOutbox(update: Api.UpdateReadHistoryOutbox) {
    const threadID = getPeerId(update.peer)
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
    this.onEvent([TelegramMapper.mapUserPresence(update.userId, update.status)])
  }

  private async onUpdateEditMessage(update: Api.UpdateEditMessage) {
    if (update.message instanceof Api.MessageEmpty) return
    const threadID = getPeerId(update.message.peerId).toString()
    const updatedMessage = this.mapper.mapMessage(update.message)
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
    const entries = this.mapper.mapMessages(res)
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
      else if (update instanceof Api.UpdateReadHistoryInbox) this.onUpdateReadHistoryInbox(update)
      else if (update instanceof Api.UpdateReadHistoryOutbox) this.onUpdateReadHistoryOutbox(update)
      else if (update instanceof Api.UpdateUserStatus) this.onUpdateUserStatus(update)
      else if (update instanceof Api.UpdateEditMessage) await this.onUpdateEditMessage(update)
      else if (update instanceof Api.UpdateReadMessagesContents) await this.onUpdateReadMessagesContents(update)
      else if (IS_DEV) console.log(stringifyCircular(update.className))
    })
  }

  private emitDeleteThread(threadID: string) {
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

  private emptyAssets = async () => {
    // for perfomance testing
    const mediaDir = path.join(this.accountInfo.dataDirPath, 'media')
    const photosDir = path.join(this.accountInfo.dataDirPath, 'photos')
    try {
      await fs.rm(mediaDir, { recursive: true })
      await fs.rm(photosDir, { recursive: true })
    // eslint-disable-next-line no-empty
    } catch {}
  }

  private afterLogin = async () => {
    // await this.emptyAssets()
    this.createAssetsDir()
    this.me = this.me || await this.client.getMe() as Api.User
    this.mapper = new TelegramMapper(this.accountInfo, this.me)
    this.meMapped = this.mapper.mapUser(this.me)
    this.registerUpdateListeners()
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
    const user = this.client.getInputEntity(userId)
    if (user instanceof Api.User) {
      return this.mapper.mapUser(user)
    }
  }

  private upsertParticipants(threadID: bigInt.BigNumber, entries: Participant[]) {
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'participant',
      objectIDs: {
        threadID: threadID.toString(),
      },
      entries,
    }])
  }

  private dialogToParticipantIdsUpdate = async (dialogId: bigInt.BigInteger, participantIds: bigInt.BigInteger[]) => {
    const dialog = this.dialogToParticipantIds.get(dialogId)
    if (dialog) {
      participantIds.forEach(id => dialog.add(id))
    } else {
      this.dialogToParticipantIds.set(dialogId, new Set(participantIds))
    }
  }

  private emitParticipantFromMessage = async (dialogId: bigInt.BigInteger, userId: bigInt.BigInteger) => {
    const participantsOnDialog = this.dialogToParticipantIds.get(dialogId)
    if (participantsOnDialog?.has(userId)) return
    const user = await this.client.getEntity(userId)
    if (user instanceof Api.User) {
      const mappedUser = this.mapper.mapUser(user)
      this.dialogToParticipantIdsUpdate(dialogId, [userId])
      this.upsertParticipants(dialogId, [mappedUser])
    }
  }

  private emitParticipants = async (dialog: Dialog) => {
    if (!dialog.id) return
    const limit = 256
    const members = await (async () => {
      try {
        return await this.client.getParticipants(dialog.id as BigInteger.BigInteger, { showTotal: true, limit })
      } catch (e) {
        if (e.code === 400) {
          // only channel admins can request users
          // if (IS_DEV) console.log(`Admin required for this channel: ${dialog.name}`)
          return []
        }
        // if (IS_DEV) console.log(`emitParticipants(): ${stringifyCircular(e, 2)}`)
        return []
      }
    })()

    if (!members) return
    const mappedMembers = await Promise.all(members.map(m => this.mapper.mapUser(m)))
    this.dialogToParticipantIdsUpdate(dialog.id, members.map(m => m.id))
    this.upsertParticipants(String(dialog.id), mappedMembers)
  }

  private saveAsset = async (buffer: Buffer, assetType: 'media' | 'photos', filename: string) => {
    const filePath = path.join(this.accountInfo.dataDirPath, assetType, filename)
    await fs.writeFile(filePath, buffer)
    return url.pathToFileURL(filePath).href
  }

  private getAssetPath = async (assetType: 'media' | 'photos', id: string | number) => {
    const filePath = path.join(this.accountInfo.dataDirPath, assetType, id.toString())
    return await fileExists(filePath) ? url.pathToFileURL(filePath).href : undefined
  }

  private createAssetsDir = () => {
    const mediaDir = path.join(this.accountInfo.dataDirPath, 'media')
    const photosDir = path.join(this.accountInfo.dataDirPath, 'photos')

    // doing it this way so there isn't a lot of try/catch
    fs.access(this.accountInfo.dataDirPath).catch(() => (fs.mkdir(this.accountInfo.dataDirPath)).catch())
    fs.access(mediaDir).catch(() => (fs.mkdir(mediaDir)).catch())
    fs.access(photosDir).catch(() => (fs.mkdir(photosDir)).catch())
  }

  private deleteAssetsDir = async () => {
    await fs.rm(this.accountInfo.dataDirPath, { recursive: true })
  }

  logout = async () => {
    await this.deleteAssetsDir()
  }

  dispose = async () => {
    await this.client?.destroy()
  }

  getCurrentUser = async (): Promise<CurrentUser> => {
    const user: CurrentUser = {
      id: this.meMapped.id,
      username: this.me.username,
      fullName: this.meMapped.fullName,
      displayText: (this.me.username ? '@' + this.me.username : '') || ('+' + this.me.phone),
    }
    return user
  }

  subscribeToEvents = (onServerEvent: OnServerEventCallback) => {
    this.onServerEvent = onServerEvent
  }

  serializeSession = () => this.sessionName

  searchUsers = async (query: string) => {
    const res = await this.client.invoke(new Api.contacts.Search({
      q: query,
    }))
    const userIds = res.users.map(user => user.id.toString())
    return Promise.all(userIds.map(async userId =>
      this.getUserById(userId)))
  }

  createThread = async (userIDs: string[], title?: string) => {
    if (userIDs.length === 0) return false
    if (!title) return false
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
      chatId: BigInteger(threadID),
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

  getThreads = async (inboxName: InboxName, pagination: PaginationArg): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 20
    let lastDate = 0
    for await (const dialog of this.client.iterDialogs({ limit, ...(cursor && { offsetDate: Number(cursor) }) })) {
      if (!dialog.id) continue
      this.dialogs[dialog.id.toString()] = dialog
      this.emitThread(this.mapThread(dialog))
      lastDate = dialog.message?.date ?? 0
    }

    return {
      items: [],
      oldestCursor: lastDate.toString() ?? '*',
      hasMore: lastDate !== 0,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 20
    const messages: Api.Message[] = []
    for await (const msg of this.client.iterMessages(threadID, { limit, maxId: +cursor || 0 })) {
      this.storeMessage(msg)
      messages.push(msg)
    }
    messages.forEach(m => this.emitParticipantFromMessage(m.chatId, m.senderId))
    return {
      items: this.mapper.mapMessages(messages),
      hasMore: messages.length !== 0,
    }
  }

  sendMessage = async (threadID: string, msgContent: MessageContent, { quotedMessageID }: MessageSendOptions) => {
    const { text } = msgContent
    const file = await getMessageContent(msgContent)
    const msgSendParams: SendMessageParams = {
      parseMode: 'md',
      message: text,
      replyTo: quotedMessageID ? Number(quotedMessageID) : undefined,
      file,
    }
    const res = await this.client.sendMessage(threadID, msgSendParams)
    this.storeMessage(res)
    return [this.mapper.mapMessage(res)]
  }

  editMessage = async (threadID: string, messageID: string, msgContent: MessageContent) => {
    let { text } = msgContent
    if (!msgContent.text || /^\s+$/.test(msgContent.text)) text = '.'
    const file = await getMessageContent(msgContent)
    await this.client.editMessage(threadID, { message: +messageID, text, file })
    return true
  }

  forwardMessage = async (threadID: string, messageID: string, threadIDs?: string[]): Promise<boolean> => {
    if (!threadIDs) return false
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
      [ActivityType.NONE]: new Api.SendMessageCancelAction(),
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

  getAsset = async (type: 'media' | 'photos', assetId: string, messageId: string, extra?: string) => {
    if (type !== 'media' && type !== 'photos') {
      texts.log(`Unknown media type ${type}`)
      return
    }
    const filePath = await this.getAssetPath(type, assetId)
    if (filePath) {
      return filePath
    }

    let buffer: Buffer
    try {
      if (type === 'media') {
        const media = this.messageMediaStore.get(+messageId)
        if (media) {
          this.messageMediaStore.delete(+messageId)
          buffer = await this.client.downloadMedia(media, { workers: 4 })
        }
      } else if (type === 'photos') {
        buffer = await this.client.downloadProfilePhoto(assetId, {})
      } else {
        if (IS_DEV) console.log(`Not a valid media type: ${type}`)
        return
      }
      if (buffer) {
        return await this.saveAsset(buffer, type, assetId)
      }
    } catch (e) {
      texts.log('err', e, JSON.stringify(e, null, 4))
      texts.Sentry.captureException(e)
    }
    // tgs stickers only appear to work on thread refresh
    // only happens first time
    texts.log(`No buffer or path for media ${type}/${assetId}/${messageId}/${extra}`)
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
