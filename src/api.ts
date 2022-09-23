/* eslint-disable @typescript-eslint/no-throw-literal */
import { randomBytes } from 'crypto'
import path from 'path'
import { promises as fsp } from 'fs'
import url from 'url'
import { setTimeout as setTimeoutAsync } from 'timers/promises'
import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, MessageSendOptions, ActivityType, ReAuthError, Participant, AccountInfo, PresenceMap, GetAssetOptions, MessageLink } from '@textshq/platform-sdk'
import { debounce } from 'lodash'
import BigInteger from 'big-integer'
import { Mutex } from 'async-mutex'
import { Api } from 'telegram/tl'
import { CustomFile } from 'telegram/client/uploads'
import { getPeerId, resolveId } from 'telegram/Utils'
import { computeCheck as computePasswordSrpCheck } from 'telegram/Password'
import type { TelegramClient } from 'telegram'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { CustomMessage } from 'telegram/tl/custom/message'
import type { SendMessageParams } from 'telegram/client/messages'
import type { TotalList } from 'telegram/Helpers'

import { API_ID, API_HASH, MUTED_FOREVER_CONSTANT, UPDATES_WATCHDOG_INTERVAL, MAX_DOWNLOAD_ATTEMPTS } from './constants'
import { AuthState } from './common-constants'
import TelegramMapper, { getMarkedId } from './mappers'
import { fileExists, stringifyCircular } from './util'
import { DbSession } from './dbSession'
import { CustomClient } from './CustomClient'

const { IS_DEV } = texts

async function getMessageContent(msgContent: MessageContent) {
  const { fileBuffer, fileName, filePath } = msgContent
  const buffer = filePath ? await fsp.readFile(filePath) : fileBuffer
  return buffer && new CustomFile(fileName, buffer.byteLength, filePath, buffer)
}

type LoginEventCallback = (authState: AuthState) => void

interface LoginInfo {
  authState?: AuthState
  phoneNumber?: string
  phoneCodeHash?: string
  phoneCode?: string
}

interface LocalState {
  pts: number
  date: number
  updateMutex: Mutex
  cancelDifference?: boolean
  watchdogTimeout?: NodeJS.Timeout
}

interface TelegramState {
  localState: LocalState
  dialogs: Map<string, Dialog>
  messageMediaStore: Map<string, Api.TypeMessageMedia>
  messageChatIdMap: Map<number, string>
  dialogIdToParticipantIds: Map<string, Set<string>>
  dialogToDialogAdminIds: Map<string, Set<string>>
  hasFetchedParticipantsForDialog: Map<string, boolean>
  pollIdMessageId: Map<string, number>
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

const getMessageFromShort = (update: Api.UpdateShortMessage | Api.UpdateShortChatMessage, peerId: Api.TypePeer, fromId: Api.TypePeer): Api.Message =>
  new Api.Message(({
    out: update.out,
    mentioned: update.mentioned,
    mediaUnread: update.mediaUnread,
    silent: update.silent,
    id: update.id,
    message: update.message,
    date: update.date,
    fwdFrom: update.fwdFrom,
    viaBotId: update.viaBotId,
    replyTo: update.replyTo,
    entities: update.entities,
    ttlPeriod: update.ttlPeriod,
    peerId,
    fromId,
  }))

const ASSET_TYPES = ['emoji', 'media', 'photos'] as const
type AssetType = typeof ASSET_TYPES[number]

export default class TelegramAPI implements PlatformAPI {
  private mapper: TelegramMapper

  private client: TelegramClient

  private accountInfo: AccountInfo

  private loginEventCallback: LoginEventCallback

  private loginInfo: LoginInfo = {}

  private me: Api.User

  private dbSession: DbSession

  private dbFileName: string

  private state: TelegramState = {
    localState: undefined,
    dialogs: new Map<string, Dialog>(),
    messageMediaStore: new Map<string, Api.TypeMessageMedia>(),
    messageChatIdMap: new Map<number, string>(),
    dialogIdToParticipantIds: new Map<string, Set<string>>(),
    dialogToDialogAdminIds: new Map<string, Set<string>>(),
    hasFetchedParticipantsForDialog: new Map<string, boolean>(),
    pollIdMessageId: new Map<string, number>(),
  }

  init = async (session: string | undefined, accountInfo: AccountInfo) => {
    this.accountInfo = accountInfo
    this.dbFileName = session as string || randomBytes(8).toString('hex')

    const dbPath = path.join(accountInfo.dataDirPath, this.dbFileName + '.sqlite')
    this.dbSession = new DbSession({ dbPath })
    await this.dbSession.init()

    this.client = new CustomClient(this.dbSession, API_ID, API_HASH, {
      retryDelay: 1_000,
      autoReconnect: true,
      connectionRetries: Infinity,
      useWSS: true,
      appVersion: texts.constants.APP_VERSION,
      deviceModel: 'Texts on ' + {
        ios: 'iOS',
        darwin: 'macOS',
        win32: 'Windows',
        linux: 'Linux',
      }[process.platform as NodeJS.Platform | 'ios'],
    })

    // TODO - remove after fix confirmation
    this.client.floodSleepThreshold = 0

    await this.client.connect()

    this.loginInfo.authState = AuthState.PHONE_INPUT

    if (session) await this.afterLogin()
  }

  getPresence = async (): Promise<PresenceMap> => {
    const status = await this.client.invoke(new Api.contacts.GetStatuses())
    return Object.fromEntries(status.map(v => [v.userId.toString(), TelegramMapper.mapUserPresence(v.userId, v.status)]))
  }

  onLoginEvent = (onEvent: LoginEventCallback) => {
    this.loginEventCallback = onEvent
    this.loginEventCallback(this.loginInfo.authState)
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
      switch (this.loginInfo.authState) {
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
          this.loginInfo.authState = AuthState.CODE_INPUT
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
          this.loginInfo.authState = AuthState.READY
          break
        }
        case AuthState.PASSWORD_INPUT: {
          const { password } = creds.custom
          if (!password) throw new Error('Password is empty')
          const passwordSrpResult = await this.client.invoke(new Api.account.GetPassword())
          const passwordSrpCheck = await computePasswordSrpCheck(passwordSrpResult, password)
          await this.client.invoke(new Api.auth.CheckPassword({ password: passwordSrpCheck }))
          this.loginInfo.authState = AuthState.READY
          break
        }
        case AuthState.READY: {
          texts.log('telegram.login: READY')
          this.dbSession.save()
          await this.afterLogin()
          return { type: 'success' }
        }
        default: {
          texts.log(`telegram.login: auth state is ${this.loginInfo.authState}`)
          return { type: 'error' }
        }
      }
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') this.loginInfo.authState = AuthState.PASSWORD_INPUT
      else {
        texts.log('telegram.login err', err, stringifyCircular(err, 2))
        texts.Sentry.captureException(err)
        return { type: 'error', errorMessage: LOGIN_ERROR_MAP[err.errorMessage] || err.errorMessage || err.message }
      }
    }

    this.loginEventCallback(this.loginInfo.authState)
    return { type: 'wait' }
  }

  private storeMessage = (message: CustomMessage) => {
    if (message.media) {
      this.state.messageMediaStore.set(String(message.id), message.media)
    }
    if (message.poll?.poll) {
      this.state.pollIdMessageId.set(String(message.poll.poll.id), message.id)
    }
    this.state.messageChatIdMap.set(message.id, String(message.chatId))
  }

  private emitMessage = (message: Api.Message | Api.MessageService) => {
    const threadID = getPeerId(message.peerId)
    const readOutboxMaxId = this.state.dialogs.get(threadID)?.dialog.readOutboxMaxId
    const mappedMessage = this.mapper.mapMessage(message, readOutboxMaxId)
    if (!mappedMessage) return
    // this.emitParticipantFromMessages(threadID, [message.senderId])
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

  private mapThread = async (dialog: Dialog) => {
    const participants = dialog.entity instanceof Api.User
      ? [this.mapper.mapParticipant(dialog.entity)]
      : (dialog.message ? [await this.getUser({ userID: String(dialog.message!.senderId) }).catch(() => undefined)].filter(Boolean) : [])
    const thread = this.mapper.mapThread(dialog, participants)
    if (dialog.message) this.storeMessage(dialog.message)
    this.state.hasFetchedParticipantsForDialog.set(thread.id, dialog.isUser)
    this.state.dialogs.set(thread.id, dialog)
    return thread
  }

  private onUpdateNewMessage = async (update: Api.UpdateNewMessage | Api.UpdateNewChannelMessage) => {
    if (update.message instanceof Api.Message || update.message instanceof Api.MessageService) this.emitMessage(update.message)
  }

  private onUpdateChatChannel = async (update: Api.UpdateChat | Api.UpdateChannel) => {
    let markedId: string
    if ('chatId' in update) { markedId = getMarkedId({ chatId: update.chatId }) } else
    if (update instanceof Api.UpdateChannel) { markedId = getMarkedId({ channelId: update.channelId }) }
    for await (const dialog of this.client.iterDialogs({ limit: 5 })) {
      const threadId = String(dialog.id)
      if (threadId === markedId) {
        const thread = await this.mapThread(dialog)
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
  }

  private onUpdateChatChannelParticipant(update: Api.UpdateChatParticipant | Api.UpdateChannelParticipant) {
    const id = 'chatId' in update ? getMarkedId({ chatId: update.chatId }) : getMarkedId({ channelId: update.channelId })
    if ('prevParticipant' in update) {
      this.emitDeleteThread(id)
    }
  }

  private onUpdateDeleteMessages(update: Api.UpdateDeleteMessages | Api.UpdateDeleteChannelMessages | Api.UpdateDeleteScheduledMessages) {
    if (!update.messages?.length) return
    const threadID = this.state.messageChatIdMap.get(update.messages[0])
    if (!threadID) return
    update.messages.forEach(m => {
      this.state.messageChatIdMap.delete(m)
    })
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      objectIDs: { threadID },
      mutationType: 'delete',
      objectName: 'message',
      entries: update.messages.map(msgId => msgId.toString()),
    }])
  }

  private onUpdateReadMessagesContents = async (update: Api.UpdateReadMessagesContents | Api.UpdateChannelReadMessagesContents) => {
    const res = await this.client.getMessages(undefined, { ids: update.messages })
    if (res.length === 0) return
    const threadID = getMarkedId({ chatId: res[0].chatId })
    const readOutboxMaxId = this.state.dialogs.get(threadID)?.dialog.readOutboxMaxId
    const entries = this.mapper.mapMessages(res, readOutboxMaxId)
    this.onEvent([{
      type: ServerEventType.STATE_SYNC,
      mutationType: 'update',
      objectName: 'message',
      objectIDs: { threadID },
      entries,
    }])
  }

  private onUpdateChatParticipants = async (update: Api.UpdateChatParticipants) => {
    if (update.participants instanceof Api.ChatParticipantsForbidden) return
    const threadID = getMarkedId(update.participants)
    const updateParticipantsIds = update.participants.participants.map(participant => String(participant.userId))

    const currentSet = this.state.dialogIdToParticipantIds.get(threadID)
    if (!currentSet) return

    const currentParticipants = Array.from(currentSet)
    const removed = currentParticipants.filter(id => !updateParticipantsIds.includes(id))
    const added = updateParticipantsIds.filter(id => !currentSet.has(id))

    if (added.length) {
      const entries = await Promise.all(added.map(id => this.getUser({ userID: id })))
      this.upsertParticipants(threadID, entries.filter(Boolean))
    }
    if (removed.length) {
      removed.forEach(id => currentSet.delete(id))
      this.onEvent([{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'participant',
        objectIDs: { threadID },
        entries: removed.map(id => ({ id, hasExited: true })),
      }])
    }
  }

  private async differenceUpdates(): Promise<void> {
    const differenceRes = await this.client.invoke(new Api.updates.GetDifference({ pts: this.state.localState.pts, date: this.state.localState.date }))
    if (differenceRes instanceof Api.updates.Difference) {
      texts.log('Received difference')
      this.state.localState = {
        ...this.state.localState,
        ...differenceRes.state,
      }
      differenceRes.newMessages?.forEach(msg => { if (msg instanceof Api.Message) this.emitMessage(msg) })
    } else if (differenceRes instanceof Api.updates.DifferenceSlice) {
      await Promise.all(differenceRes.otherUpdates.flat().map(otherUpdate => this.updateHandler(otherUpdate)))
      texts.log('Received difference slice')
      this.state.localState = {
        ...this.state.localState,
        ...differenceRes.intermediateState,
      }
      differenceRes.newMessages?.forEach(msg => { if (msg instanceof Api.Message) this.emitMessage(msg) })
      await Promise.all(differenceRes.otherUpdates.flat().map(otherUpdate => this.updateHandler(otherUpdate)))
      await this.differenceUpdates()
    } else if (differenceRes instanceof Api.updates.DifferenceTooLong) {
      texts.log('Received difference too long')
      this.state.localState.pts = differenceRes.pts
      await this.differenceUpdates()
    } else if (differenceRes instanceof Api.updates.DifferenceEmpty) {
      // nothing to do here
    }
  }

  private convertShortUpdate = (updateShort: Api.UpdateShortMessage | Api.UpdateShortChatMessage | Api.UpdateShort | Api.UpdateShortSentMessage): Api.TypeUpdate => {
    this.state.localState.date = updateShort.date
    // https://github.com/gram-js/gramjs/blob/master/gramjs/events/NewMessage.ts
    if (updateShort instanceof Api.UpdateShortMessage) {
      return new Api.UpdateNewMessage({
        message: getMessageFromShort(
          updateShort,
          new Api.PeerUser({ userId: updateShort.userId }),
          new Api.PeerUser({ userId: updateShort.out ? this.me.id : updateShort.userId }),
        ),
        pts: updateShort.pts,
        ptsCount: updateShort.ptsCount,
      })
    }
    if (updateShort instanceof Api.UpdateShortChatMessage) {
      return new Api.UpdateNewChannelMessage({
        message: getMessageFromShort(
          updateShort,
          new Api.PeerChat({ chatId: updateShort.chatId }),
          new Api.PeerUser({ userId: updateShort.out ? this.me.id : updateShort.fromId }),
        ),
        pts: updateShort.pts,
        ptsCount: updateShort.ptsCount,
      })
    }
    if (updateShort instanceof Api.UpdateShort) {
      return updateShort.update
    }
    this.state.localState.pts += updateShort.pts
  }

  private updateHandler = async (_update: Api.TypeUpdate | Api.TypeUpdates): Promise<void> => {
    const updates = 'updates' in _update ? _update.updates : _update instanceof Api.UpdateShort ? [_update.update] : [_update]
    this.state.localState.cancelDifference = true
    const handleUpdate = async (update: Api.TypeUpdate | Api.TypeUpdates) => {
      let ignore = false
      await this.state.localState.updateMutex.runExclusive(async () => {
        this.state.localState.cancelDifference = false
        // common sequence
        // only these updates contain the sync value common to all dialogs
        switch (update.className) {
          case 'UpdateNewMessage':
          case 'UpdateReadMessagesContents':
          case 'UpdateEditMessage':
          case 'UpdateDeleteMessages':
          case 'UpdateReadHistoryInbox':
          case 'UpdateReadHistoryOutbox':
          case 'UpdateWebPage':
          case 'UpdatePinnedMessages':
          case 'UpdateFolderPeers': {
            texts.log(`[Telegram] localPts = ${this.state.localState.pts} remotePts = ${update.pts} ptsCount = ${update.ptsCount}`)
            const sum = this.state.localState.pts + update.ptsCount
            if (sum > update.pts) {
              texts.log('[Telegram] Update already applied')
              this.state.localState.pts += sum
              ignore = true
            } else if (sum < update.pts) {
              texts.log('[Telegram] Missing updates')
              // we need to interrupt update handling while we resync
              await setTimeoutAsync(500)
              if (!this.state.localState.cancelDifference) await this.differenceUpdates()
              this.state.localState.cancelDifference = false
              ignore = true
            } else {
              this.state.localState.pts += update.ptsCount
              texts.log('[Telegram] Updates in sync')
            }
            break
          }
          case 'UpdatesTooLong': {
            texts.log('[Telegram] Need to sync from server state')
            const state = await this.client.invoke(new Api.updates.GetState())
            this.state.localState.date = state.date
            this.state.localState.pts = state.pts
            await this.differenceUpdates()
            ignore = true
            break
          }
          default:
            break
        }

        if (update instanceof Api.UpdateShortMessage
          || update instanceof Api.UpdateShortChatMessage
          || update instanceof Api.UpdateShortSentMessage
          || update instanceof Api.UpdateShort) {
          texts.log('[Telegram] Received short update')
          const regularUpdate = this.convertShortUpdate(update)
          this.updateHandler(regularUpdate)
          ignore = true
        }
      })

      if (ignore) return
      if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) return this.onUpdateNewMessage(update)
      if (update instanceof Api.UpdateChat || update instanceof Api.UpdateChannel) return this.onUpdateChatChannel(update)
      if (update instanceof Api.UpdateChatParticipant || update instanceof Api.UpdateChannelParticipant) return this.onUpdateChatChannelParticipant(update)
      if (update instanceof Api.UpdateDeleteMessages
        || update instanceof Api.UpdateDeleteChannelMessages
        || update instanceof Api.UpdateDeleteScheduledMessages) return this.onUpdateDeleteMessages(update)
      if (update instanceof Api.UpdateReadMessagesContents
        || update instanceof Api.UpdateChannelReadMessagesContents) return this.onUpdateReadMessagesContents(update)

      if (update instanceof Api.UpdateReadHistoryInbox || update instanceof Api.UpdateReadChannelInbox) {
        // messages we sent received were read
        const dialog = this.state.dialogs.get(('peer' in update) ? getPeerId(update.peer) : getMarkedId({ channelId: update.channelId }))
        if (dialog) dialog.dialog.readInboxMaxId = update.maxId
      }

      if (update instanceof Api.UpdateReadHistoryOutbox || update instanceof Api.UpdateReadChannelDiscussionOutbox) {
        // mesages we sent were read
        const dialog = this.state.dialogs.get(('peer' in update) ? getPeerId(update.peer) : getMarkedId({ channelId: update.channelId }))
        const maxId = 'maxId' in update ? update.maxId : update.topMsgId
        if (dialog) dialog.dialog.readOutboxMaxId = maxId
      }
      if (update instanceof Api.UpdateChatParticipants) return this.onUpdateChatParticipants(update)
      if (update instanceof Api.UpdateMessageReactions) {
        const threadID = this.state.messageChatIdMap.get(update.msgId)
        return this.onEvent([this.mapper.mapUpdateMessageReactions(update, threadID)])
      }
      // if (update instanceof Api.UpdateDraftMessage) {
      //   if (update.draft instanceof Api.DraftMessage) {
      //     const peerId = getPeerId(update.peer)
      //     this.state.dialogToDraft.set(peerId, update.draft)
      //   }
      // }
      if (update instanceof Api.UpdateMessagePoll) {
        const messageID = this.state.pollIdMessageId.get(String(update.pollId))
        if (!messageID) {
          texts.log('[Telegram] Missing messageID for poll')
          return
        }
        const threadID = this.state.messageChatIdMap.get(messageID)
        if (!threadID) {
          texts.log('[Telegram] Missing threadID for messageID')
          return
        }
        const messageUpdate = TelegramMapper.mapMessagePoll(update, threadID, String(messageID))
        if (messageUpdate) return this.onEvent([messageUpdate])
        texts.log('[Telegram] Unable to update poll')
      }
      const events = this.mapper.mapUpdate(update)
      if (events.length) this.onEvent(events)
    }
    for (const update of updates) await handleUpdate(update)
  }

  private async registerUpdateListeners() {
    const state = await this.client.invoke(new Api.updates.GetState())
    this.state.localState = { pts: state.pts, date: state.date, updateMutex: new Mutex() }
    this.client.addEventHandler(this.updateHandler)
    await this.updateWatchdog()
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

  private emptyAssets = async () => {
    // for perfomance testing
    try {
      await Promise.all(ASSET_TYPES.map(assetType =>
        fsp.rm(path.join(this.accountInfo.dataDirPath, assetType), { recursive: true })))
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
      texts.error(JSON.stringify(err, null, 2))
      if (err.code === 401 && err.errorMessage === 'AUTH_KEY_UNREGISTERED') throw new ReAuthError()
      else throw err
    }
    this.mapper = new TelegramMapper(this.accountInfo.accountID, this.me)
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

  private dialogToParticipantIdsUpdate = (threadID: string, participantIds: Iterable<string>) => {
    const set = this.state.dialogIdToParticipantIds.get(threadID)
    if (set) {
      for (const id of participantIds) {
        set.add(id)
      }
    } else {
      this.state.dialogIdToParticipantIds.set(threadID, new Set(participantIds))
    }
  }

  private upsertParticipants(threadID: string, entries: Participant[]) {
    const dialogParticipants = this.state.dialogIdToParticipantIds.get(threadID)
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

  // private emitParticipantFromMessages = async (dialogId: string, userIds: BigInteger.BigInteger[]) => {
  //   const inputEntities = await Promise.all(userIds.filter(Boolean).map(id => this.client.getInputEntity(id)))
  //   const users = await Promise.all(inputEntities.filter(e => e instanceof Api.InputPeerUser).map(ef => this.client.getEntity(ef)))
  //   const { adminIds } = await this.getDialogAdmins(dialogId)
  //   const mapped = users.map(entity => (entity instanceof Api.User ? this.mapper.mapParticipant(entity, adminIds) : undefined)).filter(Boolean)
  //   this.upsertParticipants(dialogId, mapped)
  // }

  // private emitParticipantsFromMessages = async (messages: CustomMessage[]) => {
  //   const withUserId = messages.filter(msg => (msg.fromId && 'userId' in msg.fromId)
  //     || (msg.action && 'users' in msg.action))
  //   Object.values(groupBy(withUserId, 'chatId'))
  //     // @ts-expect-error
  //     .forEach(msg => this.emitParticipantFromMessages(String((m: { chatId: any }[]) => m[0].chatId), msg.map(m => m.fromId.chatId)))
  // }

  private emitParticipants = async (dialog: Dialog) => {
    if (!dialog.id) return
    const dialogId = String(dialog.id)
    const limit = 1024
    // const { adminIds, admins } = await this.getDialogAdmins(dialogId)
    const adminIds = new Set<string>()
    const members: TotalList<Api.User> = await (() => {
      try {
        // skip the useless call altogether
        // if (dialog.isChannel && !dialog.isGroup && !(adminIds.has(this.me?.id.toString()))) return admins ?? []
        return this.client.getParticipants(dialogId, { offset: 0, limit })
      } catch (err) {
        texts.error('emitParticipants', err)
        return []
      }
    })()

    if (!members || !members.length) return
    const mappedMembers = await Promise.all(members.map(m => this.mapper.mapParticipant(m, adminIds)))
    this.upsertParticipants(dialogId, mappedMembers)
  }

  // private async getDialogAdmins(dialogId: string) {
  //   let admins: Api.User[] = []
  //   if (!this.state.dialogToDialogAdminIds.has(dialogId)) {
  //     try {
  //       admins = await this.client.getParticipants(dialogId, { filter: new Api.ChannelParticipantsAdmins() })
  //     } catch {
  //       // swallow
  //     }
  //     this.state.dialogToDialogAdminIds.set(dialogId, new Set(admins.map(a => a.id.toString())))
  //   }
  //   return { adminIds: this.state.dialogToDialogAdminIds.get(dialogId), admins }
  // }

  private createAssetsDir = async () => {
    await Promise.all(ASSET_TYPES.map(assetType =>
      fsp.mkdir(path.join(this.accountInfo.dataDirPath, assetType), { recursive: true })))
  }

  private deleteAssetsDir = async () => {
    await fsp.rm(this.accountInfo.dataDirPath, { recursive: true })
  }

  private waitForClientConnected = async () => {
    while (!this.client.connected) await setTimeoutAsync(50)
  }

  logout = async () => {
    await Promise.all([
      this.deleteAssetsDir(),
      this.client.invoke(new Api.auth.LogOut()),
    ])
  }

  dispose = async () => {
    clearTimeout(this.state.localState?.watchdogTimeout)
    await this.client?.destroy()
  }

  getCurrentUser = (): CurrentUser => {
    const user: CurrentUser = {
      ...this.mapper.mapUser(this.me),
      displayText: (this.me.username ? '@' + this.me.username : '') || ('+' + this.me.phone),
    }
    return user
  }

  subscribeToEvents = (onServerEvent: OnServerEventCallback) => {
    this.onServerEvent = onServerEvent
  }

  serializeSession = () => this.dbFileName

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
      const userID = userIDs[0]
      const user = await this.getUser({ userID })
      if (!user) throw Error('user not found')
      const thread: Thread = {
        id: userID,
        isReadOnly: false,
        isUnread: false,
        type: 'single',
        messages: { hasMore: false, items: [] },
        participants: { hasMore: false, items: [user] },
      }
      return thread
    }
    if (!title) throw Error('title required')
    await this.updateHandler(await this.client.invoke(new Api.messages.CreateChat({ users: userIDs, title })))
    return true
  }

  updateThread = async (threadID: string, updates: Partial<Thread>) => {
    if ('mutedUntil' in updates) {
      const inputPeer = await this.client.getInputEntity(threadID)
      await this.client.invoke(new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer: inputPeer }),
        settings: new Api.InputPeerNotifySettings({ muteUntil: updates.mutedUntil === 'forever' ? MUTED_FOREVER_CONSTANT : 0 }),
      }))
    }
    if ('title' in updates) {
      const dialog = this.state.dialogs.get(threadID)
      if (!dialog) throw Error('could not find dialog')
      const chatId = resolveId(BigInteger(threadID))[0]
      const tgUpdates = await this.client.invoke(dialog.isChannel
        ? new Api.channels.EditTitle({ channel: chatId, title: updates.title })
        : new Api.messages.EditChatTitle({ chatId, title: updates.title }))
      await this.updateHandler(tgUpdates)
    }
    if (typeof updates.messageExpirySeconds !== 'undefined') {
      const inputPeer = await this.client.getEntity(threadID)
      await this.updateHandler(await this.client.invoke(
        new Api.messages.SetHistoryTTL({
          peer: inputPeer,
          period: updates.messageExpirySeconds,
        }),
      ))
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
    const dialogThread = this.state.dialogs.get(threadID)
    if (!dialogThread) return
    return this.mapThread(dialogThread)
  }

  getThreads = async (inboxName: InboxName, pagination: PaginationArg): Promise<Paginated<Thread>> => {
    if (inboxName !== InboxName.NORMAL) return
    await this.waitForClientConnected()

    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 20
    let lastDate = 0

    const mapped: Promise<Thread>[] = []

    for await (const dialog of this.client.iterDialogs({ limit, ...(cursor && { offsetDate: Number(cursor) }) })) {
      if (!dialog?.id) continue
      mapped.push(this.mapThread(dialog))
      lastDate = dialog.message?.date ?? lastDate
    }

    const threads = await Promise.all(mapped)

    return {
      items: threads,
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
    const readOutboxMaxId = this.state.dialogs.get(threadID)?.dialog.readOutboxMaxId
    this.storeMessage(msg[0])
    return this.mapper.mapMessage(msg[0], readOutboxMaxId)
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    await this.waitForClientConnected()
    const { cursor } = pagination || { cursor: null, direction: null }
    const limit = 20
    const messages: Api.Message[] = []
    for await (const msg of this.client.iterMessages(threadID, { limit, maxId: +cursor || 0, waitTime: 1 })) {
      if (!msg) continue
      this.storeMessage(msg)
      messages.push(msg)
    }
    const replies = await this.getMessageReplies(BigInteger(threadID), messages)
    replies.forEach(this.storeMessage)
    messages.push(...replies)
    const readOutboxMaxId = this.state.dialogs.get(threadID)?.dialog.readOutboxMaxId
    const items = this.mapper.mapMessages(messages, readOutboxMaxId)
    // TODO: fix hack
    // setTimeout(() => this.emitParticipantsFromMessages(messages), 100)
    return {
      items,
      hasMore: messages.length !== 0,
    }
  }

  getLinkPreview = async (link: string): Promise<MessageLink> => {
    const res = await this.client.invoke(new Api.messages.GetWebPage({ url: link }))
    if (!(res instanceof Api.WebPage)) return
    const mid = String(res.photo.id)
    this.state.messageMediaStore.set(mid, new Api.MessageMediaPhoto({ photo: res.photo }))
    return this.mapper.mapMessageLink(res, mid)
  }

  onThreadSelected = async (threadID: string): Promise<void> => {
    texts.log('onThreadSelected', threadID)
    if (!threadID) return
    if (!this.state.hasFetchedParticipantsForDialog.get(threadID)) {
      const dialog = this.state.dialogs.get(threadID)
      if (!dialog) return
      texts.log(`Emitting participants for selected thread ${dialog?.title || dialog?.id}`)
      this.state.hasFetchedParticipantsForDialog.set(threadID, true)
      this.emitParticipants(dialog)
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
    // refetch to make sure msg.media is correctly present
    const fullMessage = await this.client.getMessages(threadID, { ids: res.id })
    const sentMessage = fullMessage.length ? fullMessage[0] : res
    this.storeMessage(sentMessage)
    const mapped = this.mapper.mapMessage(sentMessage, undefined)
    return mapped ? [mapped] : false
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
    await this.waitForClientConnected()
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
      await this.client.invoke(action)
    } else {
      const peer = await this.client.getInputEntity(threadID)
      if (!peer || this.state.dialogs.get(threadID)?.isChannel) return
      await this.client.invoke(new Api.messages.SetTyping({ peer, action }))
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
    const updates = await this.client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({
        folderId: Number(archived), // 1 is archived folder, 0 is non archived
        peer: await this.client.getInputEntity(threadID),
      })],
    }))
    await this.updateHandler(updates)
    if ('updates' in updates && updates.updates.length === 0) {
      this.onEvent([{
        type: ServerEventType.TOAST,
        toast: {
          text: "Can't archive this thread.",
        },
      }])
    }
  }

  addReaction = async (threadID: string, messageID: string, reactionKey: string) =>
    this.updateHandler(await this.client.invoke(new Api.messages.SendReaction({
      msgId: Number(messageID),
      peer: threadID,
      reaction: [new Api.ReactionEmoji({ emoticon: reactionKey })],
    })))

  removeReaction = async (threadID: string, messageID: string) =>
    this.updateHandler(await this.client.invoke(new Api.messages.SendReaction({
      msgId: Number(messageID),
      peer: threadID,
      reaction: [new Api.ReactionEmpty()],
    })))

  private modifyParticipant = async (threadID: string, participantID: string, remove: boolean) => {
    const inputEntity = await this.client.getInputEntity(threadID)
    try {
      let updates: Api.TypeUpdates
      if (inputEntity instanceof Api.InputPeerChat) {
        updates = remove
          ? await this.client.invoke(new Api.messages.DeleteChatUser({ chatId: inputEntity.chatId, userId: participantID }))
          : await this.client.invoke(new Api.messages.AddChatUser({ chatId: inputEntity.chatId, userId: participantID }))
      } else if (inputEntity instanceof Api.InputPeerChannel) {
        updates = await this.client.invoke(new Api.channels.InviteToChannel({ channel: inputEntity.channelId, users: [participantID] }))
      }
      if (updates) await this.updateHandler(updates)
    } catch (err) {
      if (err.code === 400) {
        this.onEvent([{
          type: ServerEventType.TOAST,
          toast: { text: 'You do not have enough permissions to invite a user.' },
        }])
      } else {
        throw err
      }
    }
  }

  addParticipant = async (threadID: string, participantID: string) => this.modifyParticipant(threadID, participantID, false)

  removeParticipant = async (threadID: string, participantID: string) => this.modifyParticipant(threadID, participantID, true)

  registerForPushNotifications = async (type: 'apple' | 'web', json: string) => {
    const { token, secret } = type === 'web'
      ? { token: json, secret: Buffer.from('') }
      : (() => {
        const parsed = JSON.parse(json) as { token: string, secret: string }
        return {
          token: parsed.token,
          secret: Buffer.from(parsed.secret, 'base64'),
        }
      })()
    const result = await this.client.invoke(new Api.account.RegisterDevice({
      token,
      // https://core.telegram.org/api/push-updates#subscribing-to-notifications
      tokenType: type === 'apple' ? 1 : 10,
      appSandbox: IS_DEV,
      noMuted: true,
      secret,
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

  private getAssetPath = (assetType: AssetType, assetId: string, extension: string) =>
    path.join(this.accountInfo.dataDirPath, assetType, `${assetId}.${extension}`)

  private async downloadAsset(filePath: string, type: AssetType, assetId: string, entityId: string) {
    switch (type) {
      case 'emoji': {
        const [document] = await this.client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: [BigInteger(assetId)] }))
        if (document instanceof Api.DocumentEmpty) throw Error('custom emoji is doc empty')
        await this.client.downloadMedia(new Api.MessageMediaDocument({ document }), { outputFile: filePath })
        return
      }
      case 'media': {
        const media = this.state.messageMediaStore.get(entityId)
        if (!media) throw Error('message media not found')
        await this.client.downloadMedia(media, { outputFile: filePath })
        this.state.messageMediaStore.delete(entityId)
        return
      }
      case 'photos': {
        await this.client.downloadProfilePhoto(entityId, { outputFile: filePath })
        return
      }
      default:
        break
    }

    throw Error(`telegram getAsset: No buffer or path for media ${type}/${assetId}/${entityId}/${entityId}`)
  }

  getAsset = async (_: GetAssetOptions, type: AssetType, assetId: string, extension: string, entityId: string/* , extra?: string */) => {
    // texts.log(type, assetId, extension, entityId, extra)
    if (!ASSET_TYPES.includes(type)) {
      throw new Error(`Unknown media type ${type}`)
    }
    const filePath = this.getAssetPath(type, assetId, extension)

    for (let attempt = 0; attempt !== MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        if (await fileExists(filePath)) {
          const file = await fsp.stat(filePath)
          if (file.size > 0) return url.pathToFileURL(filePath).href
          texts.error('File was zero bytes', filePath)
          texts.Sentry.captureMessage('[Telegram] File was zero bytes')
        }
        texts.log(`Download attempt ${attempt + 1}/${MAX_DOWNLOAD_ATTEMPTS} for ${filePath}`)
        await this.downloadAsset(filePath, type, assetId, entityId)
      } catch (err) {
        texts.error('Error downloading media', err.message)
        texts.Sentry.captureException(err)
      }
    }
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

  changeParticipantRole = async (threadID: string, participantID: string, role: string) => {
    const input = await this.client.getInputEntity(threadID)
    if (!(input instanceof Api.InputPeerChat)) return
    await this.client.invoke(new Api.messages.EditChatAdmin({
      chatId: input.chatId,
      isAdmin: role === 'admin',
      userId: BigInteger(participantID),
    }))
  }

  private updateWatchdog = async () => {
    clearTimeout(this.state.localState.watchdogTimeout)
    const current = Date.now() / 1000
    if (current > UPDATES_WATCHDOG_INTERVAL / 1000) { this.state.localState.updateMutex.runExclusive(() => this.differenceUpdates()) }
    this.state.localState.watchdogTimeout = setTimeout(() => this.updateWatchdog(), UPDATES_WATCHDOG_INTERVAL)
  }
}
