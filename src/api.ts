/* eslint-disable @typescript-eslint/no-throw-literal */
import { randomBytes } from 'crypto'
import path from 'path'
import { promises as fsp } from 'fs'
import url from 'url'
import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, MessageSendOptions, ActivityType, ReAuthError, Participant, AccountInfo, User, PresenceMap } from '@textshq/platform-sdk'
import { groupBy, debounce, difference } from 'lodash'
import BigInteger from 'big-integer'
import bluebird, { Promise } from 'bluebird'
import { TelegramClient } from 'telegram'
import { NewMessage, NewMessageEvent } from 'telegram/events'
import { Api } from 'telegram/tl'
import { CustomFile } from 'telegram/client/uploads'
import { getPeerId, resolveId } from 'telegram/Utils'
import { computeCheck as computePasswordSrpCheck } from 'telegram/Password'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { CustomMessage } from 'telegram/tl/custom/message'
import type { SendMessageParams } from 'telegram/client/messages'

import { Mutex, Semaphore } from 'async-mutex'
import { API_ID, API_HASH, MUTED_FOREVER_CONSTANT, MEDIA_SIZE_MAX_SIZE_BYTES, UPDATES_WATCHDOG_INTERVAL } from './constants'
import { REACTIONS, AuthState } from './common-constants'
import TelegramMapper, { getMarkedId } from './mappers'
import { fileExists, stringifyCircular } from './util'
import { DbSession } from './dbSession'

type LoginEventCallback = (authState: AuthState) => void

const { IS_DEV } = texts

if (IS_DEV) {
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  require('source-map-support').install()
}

async function getMessageContent(msgContent: MessageContent) {
  const { fileBuffer, fileName, filePath } = msgContent
  const buffer = filePath ? await fsp.readFile(filePath) : fileBuffer
  return buffer && new CustomFile(fileName, buffer.byteLength, filePath, buffer)
}

interface LoginInfo {
  phoneNumber?: string
  phoneCodeHash?: string
  phoneCode?: string
}

interface LocalState {
  pts: number
  date: number
  updateMutex: Mutex
  deltaTimeout?: NodeJS.Timeout
  watchdogTimeout?: NodeJS.Timeout
}

// https://core.telegram.org/method/auth.sendcode
// https://core.telegram.org/method/auth.signIn
const LOGIN_ERROR_MAP = {
  PASSWORD_HASH_INVALID: 'Password is invalid.',
  PHONE_CODE_EXPIRED: 'Code is expired.',
  PHONE_CODE_INVALID: 'Code is invalid.',
  PHONE_NUMBER_BANNED: 'Phone number is banned from Telegram.',
  PHONE_NUMBER_FLOOD: 'You asked for the code too many times.',
  PHONE_NUMBER_INVALID: 'Phone number is invalid.',
  PHONE_NUMBER_UNOCCUPIED: 'Phone number is not yet being used.',
  PHONE_PASSWORD_FLOOD: "You've tried logging in too many times. Try again after a while.",
  PHONE_PASSWORD_PROTECTED: 'Phone is password protected.',
}

const MEDIA_SIZE_MAX_SIZE_BYTES_BI = BigInteger(MEDIA_SIZE_MAX_SIZE_BYTES)
export default class TelegramAPI implements PlatformAPI {
  private client: TelegramClient

  private authState: AuthState

  private accountInfo: AccountInfo

  private loginEventCallback: LoginEventCallback

  private dbSession: DbSession

  private dialogs: Map<string, Dialog> = new Map<string, Dialog>()

  private messageMediaStore = new Map<number, Api.TypeMessageMedia>()

  private messageChatIdMap = new Map<number, string>()

  private dialogIdToParticipantIds = new Map<string, Set<string>>()

  private localState: LocalState

  private me: Api.User

  private meMapped: User

  private mapper: TelegramMapper

  private sessionName: string

  private loginInfo: LoginInfo = {}

  init = async (session: string | undefined, accountInfo: AccountInfo) => {
    this.accountInfo = accountInfo
    this.sessionName = session as string || randomBytes(8).toString('hex')

    const dbPath = path.join(accountInfo.dataDirPath, this.sessionName + '.sqlite')
    this.dbSession = new DbSession({ dbPath })

    await this.dbSession.init()

    this.client = new TelegramClient(this.dbSession, API_ID, API_HASH, {
      retryDelay: 5000,
      autoReconnect: true,
      connectionRetries: Infinity,
      maxConcurrentDownloads: 1,
      useWSS: true,
    })
    // this.client.setLogLevel(LogLevel.DEBUG)
    await this.client.connect()

    this.authState = AuthState.PHONE_INPUT

    if (session) await this.afterLogin()
  }

  getPresence = async (): Promise<PresenceMap> => {
    const status = await this.client.invoke(new Api.contacts.GetStatuses())
    return Object.fromEntries(status.map(v => [v.userId.toString(), TelegramMapper.mapUserPresence(v.userId, v.status)]))
  }

  onLoginEvent = (onEvent: LoginEventCallback) => {
    this.loginEventCallback = onEvent
    this.loginEventCallback(this.authState)
  }

  getUser = async (ids: { userID?: string } | { username?: string } | { phoneNumber?: string } | { email?: string }) => {
    const user = await (async () => {
      if ('userID' in ids) { return this.client.getEntity(ids.userID) }
      if ('username' in ids) { return this.client.getEntity(ids.username) }
      if ('phoneNumber' in ids) { return this.client.getEntity(ids.phoneNumber) }
      if ('email' in ids) { return this.client.getEntity(ids.email) }
    })()
    if (user instanceof Api.User) return this.mapper.mapUser(user)
  }

  login = async (creds: LoginCreds = {}): Promise<LoginResult> => {
    texts.log('CREDS_CUSTOM', JSON.stringify(creds.custom, null, 4))
    try {
      switch (this.authState) {
        case AuthState.PHONE_INPUT: {
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
          texts.log('telegram.login: PHONE_INPUT', JSON.stringify(res))
          this.loginInfo.phoneCodeHash = res.phoneCodeHash
          this.authState = AuthState.CODE_INPUT
          break
        }
        case AuthState.CODE_INPUT: {
          this.loginInfo.phoneCode = creds.custom.code
          if (this.loginInfo.phoneNumber === undefined || this.loginInfo.phoneCodeHash === undefined || this.loginInfo.phoneCode === undefined) throw new ReAuthError(JSON.stringify(this.loginInfo, null, 4))
          const res = await this.client.invoke(new Api.auth.SignIn({
            phoneNumber: this.loginInfo.phoneNumber,
            phoneCodeHash: this.loginInfo.phoneCodeHash,
            phoneCode: this.loginInfo.phoneCode,
          }))
          texts.log('telegram.login: CODE_INPUT', JSON.stringify(res))
          this.authState = AuthState.READY
          break
        }
        case AuthState.PASSWORD_INPUT: {
          const { password } = creds.custom
          if (!password) throw new Error('Password is empty')
          const passwordSrpResult = await this.client.invoke(new Api.account.GetPassword())
          const passwordSrpCheck = await computePasswordSrpCheck(passwordSrpResult, password)
          await this.client.invoke(new Api.auth.CheckPassword({ password: passwordSrpCheck }))
          this.authState = AuthState.READY
          break
        }
        case AuthState.READY: {
          texts.log('telegram.login: READY')
          this.dbSession.save()
          await this.afterLogin()
          return { type: 'success' }
        }
        default: {
          texts.log(`telegram.login: auth state is ${this.authState}`)
          return { type: 'error' }
        }
      }
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') this.authState = AuthState.PASSWORD_INPUT
      else {
        texts.log('telegram.login err', err, stringifyCircular(err, 2))
        texts.Sentry.captureException(err)
        return { type: 'error', errorMessage: LOGIN_ERROR_MAP[err.errorMessage] || err.errorMessage || err.message }
      }
    }

    this.loginEventCallback(this.authState)
    return { type: 'wait' }
  }

  private storeMessage = (message: CustomMessage) => {
    if (message.media) {
      this.messageMediaStore.set(message.id, message.media)
    }
    this.messageChatIdMap.set(message.id, message.chatId.toString())
  }

  private emitMessage = (message: Api.Message) => {
    const threadID = getPeerId(message.peerId)
    const readOutboxMaxId = this.dialogs.get(threadID)?.dialog.readOutboxMaxId
    const mappedMessage = this.mapper.mapMessage(message, readOutboxMaxId)
    if (!mappedMessage) return
    this.emitParticipantFromMessages(threadID, [message.senderId])
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

  private onUpdateNewMessage = async (newMessageEvent: NewMessageEvent) => {
    const { message } = newMessageEvent
    this.emitMessage(message)
  }

  private mapThread = async (dialog: Dialog) => {
    const participants = dialog.isUser
      // cloning because getParticipants returns a TotalList (a gramjs extension of Array) and TotalList doesn't deserialize correctly when sending to iOS
      ? [...await this.client.getParticipants(dialog.id, {})].map(this.mapper.mapUser)
      : []

    const thread = this.mapper.mapThread(dialog, participants)
    if (dialog.message) this.storeMessage(dialog.message)
    this.dialogs.set(thread.id, dialog)

    const participantsPromise = participants.length
      ? Promise.resolve(() => {})
      : Promise.resolve(setTimeout(() => this.emitParticipants(dialog), 500))
    return { thread, participantsPromise }
  }

  private onUpdateChatChannel = async (update: Api.UpdateChat | Api.UpdateChannel | Api.UpdateChatParticipants) => {
    let markedId: string
    if ('chatId' in update) { markedId = getMarkedId({ chatId: update.chatId }) } else if (update instanceof Api.UpdateChannel) { markedId = getMarkedId({ channelId: update.channelId }) } else { markedId = getMarkedId({ chatId: update.participants.chatId }) }
    for await (const dialog of this.client.iterDialogs({ limit: 5 })) {
      const threadId = String(dialog.id)
      if (threadId === markedId) {
        const { thread, participantsPromise } = await this.mapThread(dialog)
        await participantsPromise
        const event: ServerEvent = {
          type: ServerEventType.STATE_SYNC,
          mutationType: 'upsert',
          objectName: 'thread',
          objectIDs: {},
          entries: [thread],
        }
        this.onEvent([event])
      }
    }
    return false
  }

  private onUpdateChatChannelParticipant(update: Api.UpdateChatParticipant | Api.UpdateChannelParticipant) {
    const id = update instanceof Api.UpdateChatParticipant ? getMarkedId({ chatId: update.chatId }) : getMarkedId({ channelId: update.channelId })
    if (update.prevParticipant) {
      this.emitDeleteThread(id)
    }
    if (update.newParticipant) this.emitParticipantFromMessages(id, [update.userId])
  }

  private onUpdateDeleteMessages(update: Api.UpdateDeleteMessages | Api.UpdateDeleteChannelMessages | Api.UpdateDeleteScheduledMessages) {
    if (!update.messages?.length) return
    const threadID = this.messageChatIdMap.get(update.messages[0])
    if (!threadID) return
    update.messages.forEach(m => {
      this.messageChatIdMap.delete(m)
    })
    this.onEvent([
      {
        type: ServerEventType.STATE_SYNC,
        objectIDs: { threadID },
        mutationType: 'delete',
        objectName: 'message',
        entries: update.messages.map(msgId => msgId.toString()),
      },
    ])
  }

  private onUpdateReadMessagesContents = async (update: Api.UpdateReadMessagesContents | Api.UpdateChannelReadMessagesContents) => {
    const messageID = String(update.messages[0])
    const res = await this.client.getMessages(undefined, { ids: update.messages })
    if (res.length === 0) return
    const threadID = getMarkedId({ chatId: res[0].chatId })
    const readOutboxMaxId = this.dialogs.get(threadID)?.dialog.readOutboxMaxId
    const entries = this.mapper.mapMessages(res, readOutboxMaxId)
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'update',
      objectName: 'message',
      objectIDs: { threadID, messageID },
      entries,
    }])
  }

  private async deltaUpdates() {
    const differenceRes = await this.client.invoke(new Api.updates.GetDifference({ pts: this.localState.pts, date: this.localState.date }))
    if (differenceRes instanceof Api.updates.Difference) {
      texts.log('Received difference')
      this.localState = {
        ...this.localState,
        ...differenceRes.state,
      }
      differenceRes.newMessages?.forEach(msg => { if (msg instanceof Api.Message) this.emitMessage(msg) })
      differenceRes.otherUpdates.flat().forEach(update => this.updateHandler(update))
    } else if (differenceRes instanceof Api.updates.DifferenceSlice) {
      texts.log('Received difference slice')
      this.localState = {
        ...this.localState,
        ...differenceRes.intermediateState,
      }
      differenceRes.newMessages?.forEach(msg => { if (msg instanceof Api.Message) this.emitMessage(msg) })
      differenceRes.otherUpdates.flat().forEach(update => this.updateHandler(update))
    } else if (differenceRes instanceof Api.updates.DifferenceTooLong) {
      texts.log('Received difference too long')
      this.localState.pts = differenceRes.difference
      await this.deltaUpdates()
    } else if (differenceRes instanceof Api.updates.DifferenceEmpty) {
      // nothing to do here
    }
  }

  private updateHandler = async (update: Api.TypeUpdate | Api.TypeUpdates) => {
    const updates = 'updates' in update ? update.updates : [update]
    clearTimeout(this.localState.deltaTimeout)
    updates.forEach(async () => {
      const ignore = { _: false }
      this.localState.updateMutex.runExclusive(async () => {
        if ('pts' in update && !update.className.includes('Channel')) {
          if ('date' in update) this.localState.date = update.date
          // common sequence
          const ptsCount = 'ptsCount' in update ? update.ptsCount : 1
          texts.log(`localPts = ${this.localState.pts} remotePts = ${update.pts} ptsCount = ${ptsCount}`)
          if ((this.localState.pts + ptsCount) > update.pts) {
            texts.log('Update already applied')
            this.localState.pts += (this.localState.pts + ptsCount)
            ignore._ = true
          } else if (this.localState.pts + ptsCount < update.pts) {
            texts.log('Missing updates')
            // we need to interrupt this if an update arrives
            this.localState.deltaTimeout = setTimeout(async () => {
              await this.deltaUpdates()
            }, 500)
            ignore._ = true
          } else {
            this.localState.pts += ptsCount
            texts.log('Updates in sync')
          }
        } // channel sequence
      })

      if (ignore._) return

      if (update instanceof Api.UpdateChat
        || update instanceof Api.UpdateChannel
        || update instanceof Api.UpdateChatParticipants) return this.onUpdateChatChannel(update)
      if (update instanceof Api.ChatParticipant || update instanceof Api.UpdateChannelParticipant) return this.onUpdateChatChannelParticipant(update)
      if (update instanceof Api.UpdateDeleteMessages
        || update instanceof Api.UpdateDeleteChannelMessages
        || update instanceof Api.UpdateDeleteScheduledMessages) return this.onUpdateDeleteMessages(update)
      if (update instanceof Api.UpdateReadMessagesContents
        || update instanceof Api.UpdateChannelReadMessagesContents) return this.onUpdateReadMessagesContents(update)

      if (update instanceof Api.UpdateReadHistoryOutbox) {
        const dialog = this.dialogs.get(getPeerId(update.peer))
        if (dialog) dialog.dialog.readOutboxMaxId = update.maxId
      }
      const events = this.mapper.mapUpdate(update)
      if (events.length) this.onEvent(events)
    })
  }

  private async registerUpdateListeners() {
    const state = await this.client.invoke(new Api.updates.GetState())
    this.localState = { pts: state.pts, date: state.date, updateMutex: new Mutex() }
    this.client.addEventHandler(this.onUpdateNewMessage, new NewMessage({}))
    this.client.addEventHandler(this.updateHandler)
    this.updateWatchdog()
  }

  private emitDeleteThread(threadID: string) {
    const event: ServerEvent = {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'delete',
      objectName: 'thread',
      objectIDs: {},
      entries: [threadID],
    }
    this.onEvent([event])
  }

  private emitRefreshThread(threadID: string) {
    const event: ServerEvent = {
      type: ServerEventType.THREAD_MESSAGES_REFRESH,
      threadID,
    }
    this.onEvent([event])
  }

  private emptyAssets = async () => {
    // for perfomance testing
    const mediaDir = path.join(this.accountInfo.dataDirPath, 'media')
    const photosDir = path.join(this.accountInfo.dataDirPath, 'photos')
    try {
      await fsp.rm(mediaDir, { recursive: true })
      await fsp.rm(photosDir, { recursive: true })
    } catch {
      // ignore
    }
  }

  private afterLogin = async () => {
    // await this.emptyAssets()
    await this.createAssetsDir()
    try {
      this.me ||= await this.client.getMe() as Api.User
    } catch (err) {
      if (err.code === 401 && err.errorMessage === 'AUTH_KEY_UNREGISTERED') throw new ReAuthError()
      else throw err
    }
    this.mapper = new TelegramMapper(this.accountInfo.accountID, this.me)
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

  private upsertParticipants(dialogId: string, entries: Participant[]) {
    const threadID = dialogId
    const dialogParticipants = this.dialogIdToParticipantIds.get(threadID)
    const filteredEntries = dialogParticipants ? entries.filter(e => !dialogParticipants.has(e.id)) : entries

    if (filteredEntries.length === 0) return
    this.dialogToParticipantIdsUpdate(threadID, entries.map(m => m.id))
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'participant',
      objectIDs: {
        threadID,
      },
      entries: filteredEntries,
    }])
  }

  private dialogToParticipantIdsUpdate = (dialogId: string, participantIds: string[]) => {
    const threadID = dialogId
    const dialog = this.dialogIdToParticipantIds.get(threadID)
    if (dialog) {
      participantIds.forEach(id => dialog.add(id))
    } else {
      this.dialogIdToParticipantIds.set(threadID, new Set(participantIds))
    }
  }

  private emitParticipantFromMessages = async (dialogId: string, userIds: BigInteger.BigInteger[]) => {
    const inputEntities = await Promise.all(userIds.filter(Boolean).map(id => this.client.getInputEntity(id)))
    const users = await Promise.all(inputEntities.filter(e => e instanceof Api.InputPeerUser).map(ef => this.client.getEntity(ef)))
    const mapped = users.map(entity => (entity instanceof Api.User ? this.mapper.mapUser(entity) : undefined)).filter(Boolean)
    this.upsertParticipants(dialogId, mapped)
  }

  private emitParticipantsFromMessageAction = async (messages: CustomMessage[]) => {
    const withUserId = messages.filter(msg => (msg.fromId && 'userId' in msg.fromId)
      || (msg.action && 'users' in msg.action))
    // @ts-expect-error
    Object.values(groupBy(withUserId, 'chatId')).forEach(m => this.emitParticipantFromMessages(String(m => m[0].chatId), m.map(m => m.fromId.chatId)))
  }

  private emitParticipants = async (dialog: Dialog) => {
    if (!dialog.id) return
    const dialogId = String(dialog.id)
    const limit = 1024
    const members = await (async () => {
      try {
        const res = await this.client.getParticipants(dialogId, { showTotal: true, limit })
        return res
      } catch (e) {
        // texts.log('Error emitParticipants', e)
        if (e.code === 400) {
          // only channel admins can request users
          // texts.log(`Admin required for this channel: ${dialog.name}`)
          return []
        }
        // texts.log(`emitParticipants(): ${stringifyCircular(e, 2)}`)
        return []
      }
    })()

    if (!members) return
    const mappedMembers = await Promise.all(members.map(m => this.mapper.mapUser(m)))
    this.upsertParticipants(dialogId, mappedMembers)
  }

  private createAssetsDir = async () => {
    const mediaDir = path.join(this.accountInfo.dataDirPath, 'media')
    const photosDir = path.join(this.accountInfo.dataDirPath, 'photos')

    await fsp.mkdir(mediaDir, { recursive: true })
    await fsp.mkdir(photosDir, { recursive: true })
  }

  private deleteAssetsDir = async () => {
    await fsp.rm(this.accountInfo.dataDirPath, { recursive: true })
  }

  private waitForClientConnected = async () => {
    while (!this.client.connected) {
      await bluebird.delay(50)
    }
  }

  logout = async () => {
    await Promise.all([
      this.deleteAssetsDir(),
      this.client.invoke(new Api.auth.LogOut()),
    ])
  }

  dispose = async () => {
    clearTimeout(this.localState.deltaTimeout)
    clearTimeout(this.localState.watchdogTimeout)
    await this.client?.destroy()
  }

  getCurrentUser = (): CurrentUser => {
    const user: CurrentUser = {
      ...this.meMapped,
      displayText: (this.me.username ? '@' + this.me.username : '') || ('+' + this.me.phone),
    }
    return user
  }

  subscribeToEvents = (onServerEvent: OnServerEventCallback) => {
    this.onServerEvent = onServerEvent
  }

  serializeSession = () => this.sessionName

  searchUsers = async (query: string) => {
    const res = await this.client.invoke(new Api.contacts.Search({ q: query }))
    const users = res.users
      .map(user => user instanceof Api.User && this.mapper.mapUser(user))
      .filter(Boolean)
    return users
  }

  createThread = async (userIDs: string[], title?: string) => {
    if (userIDs.length === 0) throw Error('userIDs empty')
    if (userIDs.length === 1) {
      const user = await this.getUser({ userID: userIDs[0] })
      if (!user) throw Error('user not found')
      const thread: Thread = {
        id: userIDs[0],
        isReadOnly: false,
        isUnread: false,
        type: 'single',
        messages: { hasMore: false, items: [] },
        participants: { hasMore: false, items: [user] },
        timestamp: new Date(),
      }
      return thread
    }
    if (!title) throw Error('title required')
    await this.client.invoke(new Api.messages.CreateChat({ users: userIDs, title }))

    return true
  }

  updateThread = async (threadID: string, updates: Partial<Thread>) => {
    if ('mutedUntil' in updates) {
      const inputPeer = await this.client.getInputEntity(threadID)
      await this.client.invoke(new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({
          peer: inputPeer,
        }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil: updates.mutedUntil === 'forever' ? MUTED_FOREVER_CONSTANT : 0,
        }),
      }))
    }

    if (typeof updates.messageExpirySeconds !== 'undefined') {
      const inputPeer = await this.client.getEntity(threadID)
      await this.client.invoke(
        new Api.messages.SetHistoryTTL({
          peer: inputPeer,
          period: updates.messageExpirySeconds,
        }),
      )
      this.emitRefreshThread(threadID)
    }
  }

  deleteThread = async (threadID: string) => {
    this.client.invoke(new Api.messages.DeleteHistory({
      peer: await this.client.getInputEntity(threadID),
      revoke: false,
      justClear: true,
    }))
  }

  reportThread = async (type: 'spam', threadID: string) => {
    await this.client.invoke(new Api.account.ReportPeer({
      peer: await this.client.getInputEntity(threadID),
      reason: new Api.InputReportReasonSpam(),
      message: 'Spam',
    }))
    return true
  }

  getThread = async (threadID: string) => {
    const dialogThread = this.dialogs.get(threadID)
    if (!dialogThread) return
    const { thread, participantsPromise } = await this.mapThread(dialogThread)
    await participantsPromise
    return thread
  }

  getThreads = async (inboxName: InboxName, pagination: PaginationArg): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    await this.waitForClientConnected()

    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 20
    let lastDate = 0

    const mapped: Promise<{
      thread: Thread
      participantsPromise: Promise<any>
    }>[] = []

    for await (const dialog of this.client.iterDialogs({ limit, ...(cursor && { offsetDate: Number(cursor) }) })) {
      if (!dialog?.id) continue
      mapped.push(this.mapThread(dialog))
      lastDate = dialog.message?.date ?? lastDate
    }

    const threads = await Promise.all(mapped)
    await Promise.all(threads.map(t => t.participantsPromise))

    return {
      items: threads.map(t => t.thread),
      oldestCursor: lastDate.toString() ?? '*',
      hasMore: lastDate !== 0,
    }
  }

  private getMessageReplies = async (dialogId: BigInteger.BigInteger, messages: Api.Message[]) => {
    const replyToMessages: Api.Message[] = []
    const currentIds = messages.map(msg => msg.id)
    const unloadedReplies = messages.filter(m => m.replyToMsgId && !currentIds.includes(m.replyToMsgId)).map(m => m.replyToMsgId)
    for await (const msg of this.client.iterMessages(dialogId, { ids: unloadedReplies })) {
      if (msg) replyToMessages.push(msg)
    }
    return replyToMessages
  }

  getMessage = async (threadID: string, messageID: string) => {
    await this.waitForClientConnected()
    const msg = await this.client.getMessages(threadID, { ids: [+messageID] })
    const readOutboxMaxId = this.dialogs.get(threadID)?.dialog.readOutboxMaxId
    return this.mapper.mapMessage(msg[0], readOutboxMaxId)
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    await this.waitForClientConnected()
    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 50
    const messages: Api.Message[] = []
    for await (const msg of this.client.iterMessages(threadID, { limit, maxId: +cursor || 0 })) {
      if (!msg) continue
      this.storeMessage(msg)
      messages.push(msg)
    }
    const replies = await this.getMessageReplies(BigInteger(threadID), messages)
    replies.forEach(this.storeMessage)
    messages.push(...replies)

    setTimeout(() => this.emitParticipantsFromMessageAction(messages.filter(m => m.action)), 100)

    const readOutboxMaxId = this.dialogs.get(threadID)?.dialog.readOutboxMaxId
    return {
      items: this.mapper.mapMessages(messages, readOutboxMaxId),
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
    const fullMessage = await this.client.getMessages(threadID, { ids: res.id })
    const sentMessage = fullMessage.length ? fullMessage[0] : res
    this.storeMessage(sentMessage)
    return [this.mapper.mapMessage(sentMessage, undefined)]
  }

  editMessage = async (threadID: string, messageID: string, msgContent: MessageContent) => {
    let { text } = msgContent
    if (!msgContent.text || /^\s+$/.test(msgContent.text)) text = '.'
    const file = await getMessageContent(msgContent)
    await this.client.editMessage(threadID, { message: +messageID, text, file })
    return true
  }

  forwardMessage = async (threadID: string, messageID: string, threadIDs?: string[]): Promise<void> => {
    await Promise.all(threadIDs.map(async toThreadID => {
      const res = await this.client.forwardMessages(toThreadID, { messages: +messageID, fromPeer: threadID })
      return res.length
    }))
  }

  sendActivityIndicator = async (type: ActivityType, threadID: string) => {
    const action = {
      [ActivityType.TYPING]: new Api.SendMessageTypingAction(),
      [ActivityType.NONE]: new Api.SendMessageCancelAction(),
      [ActivityType.RECORDING_VOICE]: new Api.SendMessageRecordAudioAction(),
      [ActivityType.RECORDING_VIDEO]: new Api.SendMessageRecordVideoAction(),
      [ActivityType.ONLINE]: new Api.account.UpdateStatus({ offline: false }),
      [ActivityType.OFFLINE]: new Api.account.UpdateStatus({ offline: true }),
    }[type]
    if (!action) return
    if (action instanceof Api.account.UpdateStatus) {
      this.client.invoke(action)
    } else {
      const peer = await this.client.getInputEntity(threadID)
      if (!peer || this.dialogs.get(threadID)?.isChannel) return
      this.client.invoke(new Api.messages.SetTyping({ peer, action }))
    }
  }

  deleteMessage = async (_: string, messageID: string, forEveryone: boolean) => {
    await this.client.deleteMessages(undefined, [Number(messageID)], { revoke: forEveryone })
  }

  sendReadReceipt = async (threadID: string, messageID: string) => {
    await this.client.markAsRead(threadID, +messageID, { clearMentions: true })
  }

  markAsUnread = async (threadID: string) => {
    const dialogPeer = await this.client._getInputDialog(threadID)
    if (!dialogPeer) return
    await this.client.invoke(new Api.messages.MarkDialogUnread({ unread: true, peer: dialogPeer }))
  }

  archiveThread = async (threadID: string, archived: boolean) => {
    const res = await this.client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({
        folderId: Number(archived), // 1 is archived folder, 0 is non archived
        peer: await this.client.getInputEntity(threadID),
      })],
    }))
    if ('updates' in res && res.updates.length === 0) {
      this.onEvent([{
        type: ServerEventType.TOAST,
        toast: {
          text: 'Can\'t archive this thread.',
        },
      }])
    }
  }

  private getAssetPath = (assetType: 'media' | 'photos', assetId: string | number, extension: string) =>
    path.join(this.accountInfo.dataDirPath, assetType, `${assetId.toString()}.${extension}`)

  private downloadMediaSemaphore = new Semaphore(5)

  private profilePhotoSemaphore = new Semaphore(5)

  private async downloadAsset(filePath: string, type: 'media' | 'photos', assetId: string, entityId: string) {
    switch (type) {
      case 'media': {
        const media = this.messageMediaStore.get(+entityId)
        if (!media) throw Error('message media not found')
        if (media.className === 'MessageMediaDocument' && media.document.className === 'Document') {
          texts.log(`Will attempt to download document ${media.document?.id}`)
          if (media.document?.size >= MEDIA_SIZE_MAX_SIZE_BYTES_BI) {
            // give a chance for smaller files to take a spot in the semaphore first
            texts.log(`File is larger than ${MEDIA_SIZE_MAX_SIZE_BYTES / (1024 * 1024)} megabytes, delaying loading`)
            await bluebird.delay(400)
            texts.log(`Downloading document ${media.document?.id}`)
          }
        }
        await this.downloadMediaSemaphore.runExclusive(value => {
          texts.log(`downloadMediaSemaphore: ${value}`)
          return this.client.downloadMedia(media, { outputFile: filePath })
        })
        this.messageMediaStore.delete(+entityId)
        return
      }
      case 'photos': {
        if (this.dialogs.has(entityId)) {
          texts.log(`Downloading profile photo for chat ${this.dialogs.get(entityId)?.name}`)
        } else {
          await bluebird.delay(400)
        }
        const buffer = await this.profilePhotoSemaphore.runExclusive(value => {
          texts.log(`profilePhotoSemaphore: ${value}`)
          return this.client.downloadProfilePhoto(entityId, {})
        }) as Buffer
        await fsp.writeFile(filePath, buffer)
        return
      }
      default:
        break
    }
    throw Error(`telegram getAsset: No buffer or path for media ${type}/${assetId}/${entityId}/${entityId}`)
  }

  getAsset = async (_: any, type: 'media' | 'photos', assetId: string, extension: string, entityId: string, extra?: string) => {
    if (!['media', 'photos'].includes(type)) {
      throw new Error(`Unknown media type ${type}`)
    }
    const filePath = this.getAssetPath(type, assetId, extension)

    // TODO - remove
    // eslint-disable-next-line no-lone-blocks
    {
      if (type === 'photos') {
        const oldPath = this.getAssetPath(type, entityId, extension)
        if (await fileExists(oldPath)) {
          await fsp.rename(oldPath, filePath).catch(console.log)
          return url.pathToFileURL(filePath).href
        }
      }
    }

    if (!await fileExists(filePath)) await this.downloadAsset(filePath, type, assetId, entityId)
    return url.pathToFileURL(filePath).href
  }

  handleDeepLink = async (link: string) => {
    let message: string

    const linkParsed = new URL(link)

    if (linkParsed.host === 't.me' || linkParsed.host === 'tg') {
      const info = await this.client.invoke(new Api.help.GetDeepLinkInfo({ path: link }))
      if (info instanceof Api.help.DeepLinkInfo) {
        if (info.message) message = info.message
      }
    }

    const [, , , , type, threadID, messageID, data] = link.split('/')

    if (type === 'inline-query') {
      const peerID = resolveId(BigInteger(threadID))[0]
      const sendRes = await this.client.sendMessage(peerID, { message: decodeURIComponent(data) })
      const sentMessage = await this.client.getMessages(peerID, { ids: sendRes.id })
      if (sentMessage?.length) {
        this.emitMessage(sentMessage[0])
      }
    } else if (type === 'callback' && !message) {
      const res = await this.client.invoke(new Api.messages.GetBotCallbackAnswer({
        data: Buffer.from(data),
        peer: threadID,
        msgId: +messageID,
      }))
      if (res.message) message = res.message
    }

    if (message) {
      this.onEvent([{
        type: ServerEventType.TOAST,
        toast: {
          text: message,
        },
      }])
    }
  }

  addReaction = async (threadID: string, messageID: string, reactionKey: string) => {
    await this.client.invoke(new Api.messages.SendReaction({
      msgId: Number(messageID),
      peer: threadID,
      reaction: REACTIONS[reactionKey].render,
    }))
  }

  removeReaction = async (threadID: string, messageID: string) => {
    await this.client.invoke(new Api.messages.SendReaction({
      msgId: Number(messageID),
      peer: threadID,
      reaction: '',
    }))
  }

  private modifyParticipant = async (threadID: string, participantID: string, remove: boolean) => {
    const inputEntity = await this.client.getInputEntity(threadID)
    try {
      let res: Api.TypeUpdates // the server will send the same updates to us shortly
      if (inputEntity instanceof Api.InputPeerChat) {
        res = remove
          ? await this.client.invoke(new Api.messages.DeleteChatUser({ chatId: inputEntity.chatId, userId: participantID }))
          : await this.client.invoke(new Api.messages.AddChatUser({ chatId: inputEntity.chatId, userId: participantID }))
        texts.log(stringifyCircular(res, 2))
      } else if (inputEntity instanceof Api.InputPeerChannel) {
        // unsure if supported in Texts but call works
        res = await this.client.invoke(new Api.channels.InviteToChannel({ channel: inputEntity.channelId, users: [participantID] }))
      }
      if (res && res.className === 'Updates') {
        const newMessageUpdates = res.updates.filter(u => u.className === 'UpdateNewMessage')
        // texts.log(stringifyCircular(newMessageUpdates, 2))
        // @ts-expect-error
        if (newMessageUpdates?.length) newMessageUpdates.forEach(this.onUpdateNewMessage)
      }
    } catch (err) {
      texts.Sentry.captureException(err)
      if (err.code === 400) {
        this.onEvent([{
          type: ServerEventType.TOAST,
          toast: { text: 'You do not have enough permissions to invite a user.' },
        }])
      } else {
        texts.log(stringifyCircular(err, 2))
      }
    }
  }

  addParticipant = async (threadID: string, participantID: string) => this.modifyParticipant(threadID, participantID, false)

  removeParticipant = async (threadID: string, participantID: string) => this.modifyParticipant(threadID, participantID, true)

  registerForPushNotifications = async (type: 'apple' | 'web', token: string) => {
    const result = await this.client.invoke(new Api.account.RegisterDevice({
      token,
      // https://core.telegram.org/api/push-updates#subscribing-to-notifications
      tokenType: type === 'apple' ? 1 : 10,
      appSandbox: IS_DEV,
      noMuted: true,
      secret: Buffer.from(''),
      otherUids: [],
    }))
    if (!result) throw new Error('Could not register for push notifications')
  }

  unregisterForPushNotifications = async (type: 'apple' | 'web', token: string) => {
    const result = await this.client.invoke(new Api.account.UnregisterDevice({
      token,
      tokenType: type === 'apple' ? 1 : 10,
      otherUids: [],
    }))
    if (!result) throw new Error('Could not unregister for push notifications')
  }

  reconnectRealtime = async () => {
    // start receiving updates again
    await this.client.getMe()
  }


  private updateWatchdog = async () => {
    clearTimeout(this.localState.watchdogTimeout)
    const current = Date.now() / 1000
    if (current > UPDATES_WATCHDOG_INTERVAL / 1000) { this.localState.updateMutex.runExclusive(async () => this.deltaUpdates()) }
    this.localState.watchdogTimeout = setTimeout(() => this.updateWatchdog(), UPDATES_WATCHDOG_INTERVAL)
  }
}
