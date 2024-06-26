import path from 'path'
import { promises as fsp } from 'fs'
import url from 'url'
import { setTimeout as sleep } from 'timers/promises'
import { PlatformAPI, OnServerEventCallback, LoginResult, Paginated, Thread, Message, CurrentUser, InboxName, MessageContent, PaginationArg, texts, LoginCreds, ServerEvent, ServerEventType, MessageSendOptions, ActivityType, ReAuthError, Participant, ClientContext, PresenceMap, GetAssetOptions, MessageLink, StickerPack, SupportedReaction, OverridablePlatformInfo, ThreadFolderName, NotificationsInfo, PaginatedWithCursors, AppState } from '@textshq/platform-sdk'
import { debounce, uniqBy } from 'lodash'
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
import type { FileLike } from 'telegram/define'

import { API_ID, API_HASH, MUTED_FOREVER_CONSTANT, MAX_DOWNLOAD_ATTEMPTS } from './constants'
import { AuthState } from './common-constants'
import TelegramMapper, { getMarkedId, STICKER_PREFIX } from './mappers'
import { fileExists, stringifyCircular, toJSON } from './util'
import { DbSession } from './dbSession'
import { CustomClient } from './CustomClient'

const { IS_DEV } = texts

// @ts-expect-error
const IS_iOS = process.platform === 'ios'

function getFileFromMessageContent(msgContent: MessageContent): FileLike {
  const { fileBuffer, fileName, filePath } = msgContent
  if (fileBuffer) return new CustomFile(fileName, fileBuffer.byteLength, filePath, fileBuffer)
  return filePath
}

type LoginEventCallback = ({ authState, qrLink }: { authState: AuthState, qrLink?: string }) => void

interface LocalState {
  pts: number
  seq: number
  date: number
  mutex: Mutex
}

interface TelegramState {
  localState: LocalState
  getDifferenceMutex: Mutex
  hasSynced: boolean
  dialogs: Map<string, Dialog>
  mediaStore: Map<string, Api.TypeMessageMedia>
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

const QR_CODE_TIMEOUT = 30_000

export default class TelegramAPI implements PlatformAPI {
  private mapper: TelegramMapper

  private client: TelegramClient

  private accountInfo: ClientContext

  private loginEventCallback: LoginEventCallback

  private loginInfo: {
    authState?: AuthState
    phoneNumber?: string
    phoneCodeHash?: string
    phoneCode?: string
  } = {}

  private me: Api.User

  private db: DbSession

  private state: TelegramState = {
    localState: { mutex: new Mutex(), date: 0, pts: 0, seq: 0 },
    getDifferenceMutex: new Mutex(),
    hasSynced: false,
    dialogs: new Map<string, Dialog>(),
    mediaStore: new Map<string, Api.TypeMessageMedia>(),
    messageChatIdMap: new Map<number, string>(),
    dialogIdToParticipantIds: new Map<string, Set<string>>(),
    dialogToDialogAdminIds: new Map<string, Set<string>>(),
    hasFetchedParticipantsForDialog: new Map<string, boolean>(),
    pollIdMessageId: new Map<string, number>(),
  }

  init = async (session: string | undefined, accountInfo: ClientContext) => {
    this.accountInfo = accountInfo

    const dbPath = path.join(accountInfo.dataDirPath, 'db.sqlite')
    if (typeof session === 'string') { // legacy migration for existing accounts
      if (session !== 'db') await fsp.rename(path.join(accountInfo.dataDirPath, session + '.sqlite'), dbPath)
      await this.emptyAssetsDir()
    }

    this.db = new DbSession(dbPath)
    await this.db.initPromise

    this.client = new CustomClient(this.db, API_ID, API_HASH, {
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

    if (session) await this.afterLogin()
    else this.loginInfo.authState = AuthState.PHONE_INPUT
  }

  getPresence = async (): Promise<PresenceMap> => {
    const status = await this.client.invoke(new Api.contacts.GetStatuses())
    return Object.fromEntries(status.map(v => [v.userId.toString(), TelegramMapper.mapUserPresence(v.userId, v.status)]))
  }

  private async signInWithQrCode() {
    let isScanningComplete = false
    const exportToken = () => this.client.invoke(new Api.auth.ExportLoginToken({ apiId: API_ID, apiHash: API_HASH, exceptIds: [] }))
    const inputPromise = (async () => {
      while (!isScanningComplete) {
        const exportResult1 = await exportToken()
        if (!(exportResult1 instanceof Api.auth.LoginToken)) throw new Error('Unexpected')
        const { token } = exportResult1
        await Promise.race([
          this.loginEventCallback({ authState: AuthState.QR_CODE, qrLink: `tg://login?token=${token.toString('base64url')}` }),
          sleep(QR_CODE_TIMEOUT),
        ])
        await sleep(QR_CODE_TIMEOUT)
      }
    })()
    const updatePromise = new Promise(resolve => {
      const callback = (update: Api.TypeUpdate) => {
        if (!(update instanceof Api.UpdateLoginToken)) return
        this.loginEventCallback({ authState: this.loginInfo.authState })
        this.client.removeEventHandler(callback, undefined)
        resolve(undefined)
      }
      this.client.addEventHandler(callback)
    })
    try {
      await Promise.race([updatePromise, inputPromise])
    } finally {
      isScanningComplete = true
    }
    const exportResult2 = await exportToken()
    if (exportResult2 instanceof Api.auth.LoginTokenSuccess && exportResult2.authorization instanceof Api.auth.Authorization) {
      return true
    }
    if (exportResult2 instanceof Api.auth.LoginTokenMigrateTo) {
      await this.client._switchDC(exportResult2.dcId)
      const migratedResult = await this.client.invoke(new Api.auth.ImportLoginToken({ token: exportResult2.token }))
      if (migratedResult instanceof Api.auth.LoginTokenSuccess && migratedResult.authorization instanceof Api.auth.Authorization) {
        return true
      }
    }
    throw new Error(`Unexpected result while scanning QR ${exportResult2.className}`)
  }

  onLoginEvent = (onEvent: LoginEventCallback) => {
    this.loginEventCallback = onEvent
    this.loginEventCallback({ authState: this.loginInfo.authState })
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
    if (!('custom' in creds)) throw Error('unexpected')
    const { custom } = creds
    try {
      if (custom === 'qr') {
        this.loginInfo.authState = AuthState.QR_CODE
        await this.signInWithQrCode()
        this.loginInfo.authState = AuthState.READY
      }
      switch (this.loginInfo.authState) {
        case AuthState.PHONE_INPUT: {
          this.loginInfo.phoneNumber = custom.phoneNumber
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
          // https://github.com/gram-js/gramjs/blob/270751101c0b94c49f9cbfe46f87e55618b2dd03/gramjs/client/auth.ts#L385
          if (res instanceof Api.auth.SentCodeSuccess) throw new Error('Logged in right after sending code')
          if (res instanceof Api.auth.SentCode) this.loginInfo.phoneCodeHash = res.phoneCodeHash
          this.loginInfo.authState = AuthState.CODE_INPUT
          break
        }
        case AuthState.CODE_INPUT: {
          this.loginInfo.phoneCode = custom.code
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
          const { password } = custom
          if (!password) throw new Error('Empty password')
          const passwordSrpResult = await this.client.invoke(new Api.account.GetPassword())
          const passwordSrpCheck = await computePasswordSrpCheck(passwordSrpResult, password)
          await this.client.invoke(new Api.auth.CheckPassword({ password: passwordSrpCheck }))
          this.loginInfo.authState = AuthState.READY
          break
        }
        case AuthState.READY: {
          texts.log('telegram.login: READY')
          await this.afterLogin()
          return { type: 'success' }
        }
        default: {
          throw Error(`telegram.login: unhandled auth state ${this.loginInfo.authState}`)
        }
      }
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        this.loginInfo.authState = AuthState.PASSWORD_INPUT
      } else {
        const expectedError = LOGIN_ERROR_MAP[err.errorMessage]
        if (expectedError) return { type: 'error', errorMessage: expectedError }
        texts.log('telegram.login err', err, stringifyCircular(err, 2))
        texts.Sentry.captureException(err)
        throw err
      }
    }
    this.loginEventCallback({ authState: this.loginInfo.authState })
    return { type: 'wait' }
  }

  private storeMessage = (message: CustomMessage) => {
    const actionPhoto = (message.action && 'photo' in message.action) ? message.action.photo : undefined
    if (message.media || actionPhoto) {
      this.state.mediaStore.set(String(message.id), message.media || (actionPhoto ? new Api.MessageMediaPhoto({ photo: actionPhoto }) : undefined))
    }
    if (message.poll?.poll) {
      this.state.pollIdMessageId.set(String(message.poll.poll.id), message.id)
    }
    this.state.messageChatIdMap.set(message.id, String(message.chatId))
  }

  private emitMessage = (message: Api.Message | Api.MessageService) => {
    const threadID = getPeerId(message.peerId)
    const thread = this.state.dialogs.get(threadID)
    if (thread?.isChannel) this.emitParticipantsFromMessages(threadID, [message])
    const readOutboxMaxId = thread?.dialog.readOutboxMaxId
    const mappedMessage = this.mapper.mapMessage(message, readOutboxMaxId)
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
    const threadID = getPeerId(dialog.id)
    if (dialog.message) this.storeMessage(dialog.message)
    this.state.hasFetchedParticipantsForDialog.set(threadID, dialog.isUser)
    this.state.dialogs.set(threadID, dialog)
    const participants = dialog.entity instanceof Api.User
      ? [this.mapper.mapParticipant(dialog.entity)]
      : (dialog.message ? [await this.getUser({ userID: String(dialog.message!.senderId) }).catch(() => undefined)].filter(Boolean) : [])
    const thread = this.mapper.mapThread(dialog, participants)
    return thread
  }

  private onUpdateNewMessage = async (update: Api.UpdateNewMessage | Api.UpdateNewChannelMessage) => {
    if (update.message instanceof Api.Message || update.message instanceof Api.MessageService) this.emitMessage(update.message)
  }

  private onUpdateChatChannel = async (update: Api.UpdateChat | Api.UpdateChannel) => {
    let markedId: string
    if ('chatId' in update) {
      markedId = getMarkedId({ chatId: update.chatId })
    } else if (update instanceof Api.UpdateChannel) {
      markedId = getMarkedId({ channelId: update.channelId })
    }
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

  private convertShortUpdate = (updateShort: Api.UpdateShortMessage | Api.UpdateShortChatMessage | Api.UpdateShort | Api.UpdateShortSentMessage): Api.TypeUpdate => {
    // this.state.localState.date = updateShort.date
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
  }

  private static SHORT_UPDATES = ['UpdateShortMessage', 'UpdateShortChatMessage', 'UpdateShortSentMessage', 'UpdateShort']

  private static NORMAL_UPDATES = [
    'UpdateNewMessage',
    'UpdateDeleteMessages',
    'UpdateReadHistoryInbox',
    'UpdateReadHistoryOutbox',
    'UpdateWebPage',
    'UpdateReadMessagesContents',
    'UpdateEditMessage',
    'UpdateFolderPeers',
    'UpdatePinnedMessages',
  ]

  private updateHandler = async (_update: Api.TypeUpdate | Api.TypeUpdates): Promise<void> => {
    const handleUpdate = async (update: Api.TypeUpdate | Api.TypeUpdates) => {
      let ignore = false
      if (update.className === 'UpdatesTooLong') {
        await this.syncCommonState()
        ignore = true
      } else if (TelegramAPI.SHORT_UPDATES.includes(update.className)) {
        const regularUpdate = this.convertShortUpdate(update as Api.UpdateShort)
        handleUpdate(regularUpdate)
        return
      } else if (TelegramAPI.NORMAL_UPDATES.includes(update.className) && !('channelId' in update)) {
        const { pts, ptsCount } = update as { pts: number, ptsCount: number }
        const sum = this.state.localState.pts + ptsCount
        if (sum === pts) {
          // update can be applied
          this.state.localState.pts = sum
        } else if (sum > pts) {
          // update already applied. ignore
          ignore = true
        } else if (sum < pts) {
          // update missing. need to fetch difference
          await this.syncCommonState()
          ignore = true
        }

        this.saveCommonState()
      }

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
        if (!threadID) return texts.Sentry.captureMessage('[Telegram] Api.UpdateMessageReactions missing threadID for messageID')
        return this.onEvent([this.mapper.mapUpdateMessageReactions(update, threadID)])
      }
      if (update instanceof Api.UpdateMessagePoll) {
        const messageID = this.state.pollIdMessageId.get(String(update.pollId))
        if (!messageID) return texts.Sentry.captureMessage('[Telegram] Api.UpdateMessagePoll missing messageID for pollID')
        const threadID = this.state.messageChatIdMap.get(messageID)
        if (!threadID) return texts.Sentry.captureMessage('[Telegram] Api.UpdateMessagePoll missing threadID for messageID')
        const messageUpdate = TelegramMapper.mapUpdateMessagePoll(update, threadID, String(messageID))
        if (messageUpdate) return this.onEvent([messageUpdate])
      }
      if (update instanceof Api.UpdateUser) {
        const user = await this.getUser({ userID: update.userId.toString() })
        return this.onEvent([{
          type: ServerEventType.STATE_SYNC,
          mutationType: 'update',
          objectName: 'participant',
          objectIDs: { threadID: user.id },
          entries: [user],
        }])
      }
      const events = this.mapper.mapUpdate(update)
      if (events.length) this.onEvent(events)
    }
    await this.state.localState.mutex.runExclusive(async () => {
      if (_update.className === 'UpdatesCombined' || _update.className === 'Updates') {
        const { updates } = _update
        const seqStart = _update.className === 'Updates' ? _update.seq : _update.seqStart
        const newSeq = this.state.localState.seq + 1
        if (seqStart === 0) {
          for (const update of updates) await handleUpdate(update)
        } else if (newSeq === seqStart) {
          for (const update of updates) await handleUpdate(update)
          this.state.localState.seq = _update.seq
          this.state.localState.date = _update.date
        } else if (newSeq < seqStart) {
          await this.syncCommonState()
        } else if (newSeq > seqStart) {
          // updates applied. ignore
        }
      } else if (_update instanceof Api.UpdateShort) {
        await handleUpdate(_update.update)
      } else {
        await handleUpdate(_update)
      }
    })
  }

  private async registerUpdateListeners() {
    this.client.addEventHandler(this.updateHandler)
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

  private async getReactions() {
    const cached = this.db.cacheGetHash('GetAvailableReactions')
    const networkReactions = await this.client.invoke(new Api.messages.GetAvailableReactions(cached ? { hash: +cached } : {}))
    const isCached = networkReactions instanceof Api.messages.AvailableReactionsNotModified
    const reactions = isCached ? this.db.cacheGetValue<Api.messages.AvailableReactions>('GetAvailableReactions') : networkReactions
    if (!isCached) this.db.cacheSet('GetAvailableReactions', networkReactions.hash, networkReactions.getBytes())
    return reactions
  }

  getPlatformInfo = async (): Promise<OverridablePlatformInfo> => {
    const [reactions, appConfigRes] = await Promise.all([
      this.getReactions(),
      this.client.invoke(new Api.help.GetAppConfig({})),
    ])
    const supported = reactions.reactions.map<[string, SupportedReaction]>(r => {
      if (r.inactive || (r.premium && !this.me.premium)) return
      const emoji = r.reaction.replace('❤', '❤️')
      return [emoji, { title: emoji, render: emoji }]
    }).filter(Boolean)
    const appConfig = toJSON((appConfigRes as Api.help.AppConfig).config)
    const maxFileSize = (this.me.premium ? appConfig.upload_max_fileparts_premium : appConfig.upload_max_fileparts_default) * (512 * 1024)
    return {
      reactions: {
        supported: Object.fromEntries(supported),
        allowsMultipleReactionsToSingleMessage: this.me.premium,
      },
      attachments: {
        supportsCaption: true,
        supportsStickers: true,
        recordedAudioMimeType: 'audio/ogg',
        gifMimeType: 'video/mp4',
        maxSize: {
          image: maxFileSize,
          video: maxFileSize,
          audio: maxFileSize,
          files: maxFileSize,
        },
      },
    }
  }

  private afterLogin = async () => {
    await this.createAssetsDir()
    try {
      this.me ||= await this.client.getMe() as Api.User
    } catch (err) {
      texts.error('telegram getMe error', JSON.stringify(err, null, 2))
      if ((err.code === 401 && err.errorMessage === 'AUTH_KEY_UNREGISTERED')
        || (err.code === 406 && err.errorMessage === 'AUTH_KEY_DUPLICATED')) throw new ReAuthError(err.message ?? err.errorMessage)
      else throw err
    }
    this.mapper = new TelegramMapper(this.accountInfo.accountID, this.me)
    await this.initializeLocalState()
    this.registerUpdateListeners()
  }

  private saveCommonState = () => {
    this.db.saveState('common_state', {
      pts: this.state.localState.pts,
      seq: this.state.localState.seq,
      date: this.state.localState.date,
    })
  }

  private async initializeLocalState() {
    await this.state.localState.mutex.runExclusive(async () => {
      if (!IS_iOS) {
        const serverState = await this.client.invoke(new Api.updates.GetState())
        this.state.localState.date = serverState.date
        this.state.localState.pts = serverState.pts
        this.state.localState.seq = serverState.seq
        return
      }

      const localState = this.db.getState<LocalState>('common_state')
      if (localState) {
        this.state.localState.date = localState.date
        this.state.localState.pts = localState.pts
        this.state.localState.seq = localState.seq
        await this.syncCommonState()
      } else {
        const serverState = await this.client.invoke(new Api.updates.GetState())
        this.state.localState.date = serverState.date
        this.state.localState.pts = serverState.pts
        this.state.localState.seq = serverState.seq
        this.saveCommonState()
      }
      texts.log('telegram.initializeLocalState', this.state.localState)
    })
  }

  private async syncCommonState() {
    await this.state.getDifferenceMutex.runExclusive(() => this._syncCommonState())
  }

  private async _syncCommonState() {
    if (this.state.localState.pts === 0) {
      return
    }

    const serverState = await this.client.invoke(new Api.updates.GetState())
    console.log(`[Telegram] Syncing common state. Local: ${this.state.localState.pts}, Server: ${serverState.pts}`)
    if (serverState.pts !== this.state.localState.pts) {
      this.state.hasSynced = await this.getDifference(this.state.localState.pts, this.state.localState.date)
    } else {
      this.state.hasSynced = true
    }
  }

  private async getDifference(pts: number, date?: number): Promise<boolean> {
    const difference = await this.client.invoke(new Api.updates.GetDifference({ pts, date }))

    if (difference.className === 'updates.DifferenceEmpty') return true
    if (difference.className === 'updates.DifferenceTooLong') {
      // ~~The difference is too long, and the specified state must be used to refetch updates.~~
      // We should just refetch from scratch instead. Although we should have a way to nuke the cache on iOS sidew
      return false
    }

    const mappedEvents: ServerEvent[] = []

    const collectedMessages = difference.newMessages.reduce((acc, message) => {
      if (message instanceof Api.MessageEmpty) return acc
      const threadID = getPeerId(message.peerId)
      if (!acc[threadID]) acc[threadID] = []

      const mappedMessage = this.mapper.mapMessage(message)
      if (!mappedMessage) return acc

      acc[threadID].push(mappedMessage)
      this.storeMessage(message)
      return acc
    }, {} as Record<string, Message[]>)

    for (const [threadID, messages] of Object.entries(collectedMessages)) {
      if (!messages.length) continue
      const event: ServerEvent = {
        type: ServerEventType.STATE_SYNC,
        mutationType: 'upsert',
        objectName: 'message',
        objectIDs: { threadID },
        entries: messages,
      }
      mappedEvents.push(event)
    }

    // TODO: if (data.newEncryptedMessages.length) {}

    if (difference.otherUpdates.length) {
      mappedEvents.push(...difference.otherUpdates.flatMap(this.mapper.mapUpdate))
    }

    this.onEvent(mappedEvents)

    if (difference.className === 'updates.DifferenceSlice') {
      return this.getDifference(difference.intermediateState.pts, difference.intermediateState.date)
    }

    this.state.localState.pts = difference.state.pts
    this.state.localState.date = difference.state.date
    this.state.localState.seq = difference.state.seq
    this.saveCommonState()
    return true
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
  }, 200)

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

  private emitParticipantsFromMessages = async (threadID: string, messages: CustomMessage[]) => {
    const users = await Promise.all(messages.map(m => m.getSender()))
    // const { adminIds } = await this.getDialogAdmins(threadID)
    const mapped = uniqBy(users.map(entity => (entity instanceof Api.User ? this.mapper.mapUser(entity) : undefined)).filter(Boolean), 'id')
    this.upsertParticipants(threadID, mapped)
  }

  private emitParticipants = async (dialog: Dialog) => {
    if (!dialog.id) return
    const dialogId = String(dialog.id)
    const limit = dialog.isChannel ? 256 : 1024
    // const { adminIds, admins } = await this.getDialogAdmins(dialogId)
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
    // the cloning fixes TotalList serialization on ios
    const mappedMembers = [...members.map(m => this.mapper.mapParticipant(m))]
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

  private createAssetsDir = () =>
    Promise.all(ASSET_TYPES.map(assetType =>
      fsp.mkdir(path.join(this.accountInfo.dataDirPath, assetType), { recursive: true })))

  private emptyAssetsDir = () => {
    texts.log('emptyAssetsDir')
    return Promise.all(ASSET_TYPES.map(assetType =>
      fsp.rm(path.join(this.accountInfo.dataDirPath, assetType), { recursive: true })))
  }

  private deleteDataDir = () =>
    fsp.rm(this.accountInfo.dataDirPath, { recursive: true })

  private waitForClientConnected = async () => {
    const start = Date.now()
    while (!this.client?.connected) {
      await sleep(50)
      const elapsed = Date.now() - start
      if (elapsed > 2 * 60_000) {
        throw Error('timed out waiting for client connection')
      } else if (elapsed > 10_000) {
        texts.Sentry.captureMessage('[Telegram] >10s passed waiting for client connection')
      }
    }
  }

  logout = async () => {
    await Promise.all([
      this.deleteDataDir(),
      this.client.invoke(new Api.auth.LogOut()),
    ])
  }

  dispose = async () => {
    this.db?.close()
    await this.client?.destroy()
  }

  getCurrentUser = (): CurrentUser =>
    this.mapper.mapUser(this.me)

  subscribeToEvents = (onServerEvent: OnServerEventCallback) => {
    this.onServerEvent = onServerEvent
    // call debouncedPushEvents to flush any pending events before subscribeToEvents was called
    this.debouncedPushEvents()
  }

  // eslint-disable-next-line class-methods-use-this
  serializeSession = () => ({
    version: 1,
  })

  searchUsers = async (query: string) => {
    if (!query) return []
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
    const result = await this.client.invoke(new Api.messages.CreateChat({ users: userIDs, title }))
    await this.updateHandler(result)
    if (!('chats' in result)) throw new Error('couldnt find chat')
    // eslint-disable-next-line prefer-const
    const threadID = result.chats.find(chat => chat.className === 'Chat')?.id
    if (!threadID) throw new Error('could not find threadID')

    for await (const dialog of this.client.iterDialogs({ limit: 5 })) {
      if (String(dialog.id) === getMarkedId({ chatId: threadID })) {
        return this.mapThread(dialog)
      }
    }

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
    await this.client.invoke(new Api.messages.DeleteHistory({
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
    await this.deleteThread(threadID)
    return true
  }

  getThread = async (threadID: string) => {
    const dialogThread = this.state.dialogs.get(threadID)
    if (!dialogThread) return
    return this.mapThread(dialogThread)
  }

  getThreads = async (inboxName: ThreadFolderName, pagination?: PaginationArg): Promise<PaginatedWithCursors<Thread>> => {
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

  private getUnmappedMessage = async (threadID: string, messageID: string) => {
    await this.waitForClientConnected()
    const msg = await this.client.getMessages(threadID, { ids: [+messageID] })
    return msg[0]
  }

  getMessage = async (threadID: string, messageID: string) => {
    const msg = await this.getUnmappedMessage(threadID, messageID)
    if (!msg) return
    const readOutboxMaxId = this.state.dialogs.get(threadID)?.dialog.readOutboxMaxId
    this.storeMessage(msg)
    return this.mapper.mapMessage(msg, readOutboxMaxId)
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
    const thread = this.state.dialogs.get(threadID)
    const readOutboxMaxId = thread?.dialog.readOutboxMaxId
    const items = this.mapper.mapMessages(messages, readOutboxMaxId)
    if (thread?.isChannel) this.emitParticipantsFromMessages(threadID, messages)
    return {
      items,
      hasMore: messages.length !== 0,
    }
  }

  getLinkPreview = async (link: string): Promise<MessageLink> => {
    const res = await this.client.invoke(new Api.messages.GetWebPage({ url: link }))
    if (!(res.webpage instanceof Api.WebPage)) return
    const { photo } = res.webpage
    const photoID = photo ? String(photo.id) : undefined
    if (photo) this.state.mediaStore.set(photoID, new Api.MessageMediaPhoto({ photo }))
    return this.mapper.mapMessageLink(res.webpage, photoID)
  }

  onThreadSelected = async (threadID: string): Promise<void> => {
    if (!threadID) return
    if (!this.state.hasFetchedParticipantsForDialog.get(threadID)) {
      const dialog = this.state.dialogs.get(threadID)
      if (!dialog) return
      texts.log(`onThreadSelected: emitting participants for ${dialog?.title || dialog?.id}`)
      this.state.hasFetchedParticipantsForDialog.set(threadID, true)
      this.emitParticipants(dialog)
    }
  }

  sendMessage = async (threadID: string, msgContent: MessageContent, { quotedMessageID }: MessageSendOptions) => {
    const { text, stickerID } = msgContent
    const file = stickerID
      ? this.state.mediaStore.get(STICKER_PREFIX + stickerID) as Api.MessageMediaDocument
      : getFileFromMessageContent(msgContent)
    const msgSendParams: SendMessageParams = {
      parseMode: 'md',
      message: text,
      replyTo: quotedMessageID ? Number(quotedMessageID) : undefined,
      file,
      linkPreview: msgContent.links?.length > 0 ? msgContent.links.every(l => l.includePreview) : undefined,
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
    const file = getFileFromMessageContent(msgContent)
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
        if (remove) throw Error('not implemented')
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

  addParticipant = (threadID: string, participantID: string) => this.modifyParticipant(threadID, participantID, false)

  removeParticipant = (threadID: string, participantID: string) => this.modifyParticipant(threadID, participantID, true)

  registerForPushNotifications = async (type: keyof NotificationsInfo, json: string) => {
    if (type === 'android') throw Error('invalid type')
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

  unregisterForPushNotifications = async (type: keyof NotificationsInfo, token: string) => {
    if (type === 'android') throw Error('invalid type')
    const result = await this.client.invoke(new Api.account.UnregisterDevice({
      token,
      tokenType: type === 'apple' ? 1 : 10,
      otherUids: [],
    }))
    if (!result) throw new Error('Could not unregister for push notifications')
  }

  onAppStateChange = async (state: AppState) => {
    switch (state) {
      case AppState.SUSPENDING:
        await this.client.disconnect()
        break
      case AppState.RESUMING:
        await this.client.connect()
        // allow a short period of time for the reconnect to handle missing updates
        // syncCommonState will still be called after to make sure we don't miss anything
        await sleep(500)
        await this.state.localState.mutex.runExclusive(() => this.syncCommonState())
        break
      default:
        break
    }
  }

  reconnectRealtime = async () => {
    if (IS_iOS) return
    // start receiving updates again
    await this.client.getMe()
  }

  private getAssetPath = (assetType: AssetType, id: string, fileName: string) =>
    path.join(this.accountInfo.dataDirPath, assetType, id + '_' + fileName)

  private async downloadAsset(filePath: string, assetType: AssetType, id: string, name: string) {
    switch (assetType) {
      case 'emoji': {
        const [document] = await this.client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: [BigInteger(id)] }))
        if (document instanceof Api.DocumentEmpty) throw Error('custom emoji is doc empty')
        await this.client.downloadMedia(new Api.MessageMediaDocument({ document }), { outputFile: filePath })
        return
      }
      case 'media': {
        const [threadID, messageID] = id.split('_')
        const [key] = name.split('.')
        const media = this.state.mediaStore.get(key) || (await this.getUnmappedMessage(threadID, messageID))?.media
        if (!media) {
          console.log(`${assetType}/${id}/${name}`)
          throw Error('message media not found')
        }
        await this.client.downloadMedia(media, { outputFile: filePath })
        if (!key.startsWith(STICKER_PREFIX)) this.state.mediaStore.delete(key)
        return
      }
      case 'photos': {
        const [key] = name.split('.')
        await this.client.downloadProfilePhoto(key, { outputFile: filePath })
        return
      }
      default:
        break
    }

    throw Error(`telegram getAsset: No buffer or path for media ${assetType}/${id}/${name}`)
  }

  private downloadingAssets = new Map<string, Promise<void>>()

  getAsset = async (_: GetAssetOptions, _type: string, id: string, fileName: string) => {
    const type = _type as AssetType
    if (!ASSET_TYPES.includes(type)) {
      throw new Error(`Unknown media type ${type}`)
    }
    const filePath = this.getAssetPath(type, id, fileName)

    for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const key = [filePath, type, id, fileName].join('-')
        if (this.downloadingAssets.has(key)) {
          await this.downloadingAssets.get(key)
        } else {
          if (await fileExists(filePath)) {
            const file = await fsp.stat(filePath)
            if (file.size > 0) return url.pathToFileURL(filePath).href
            await fsp.rm(filePath)
            texts.error('[tg] 0 byte file', filePath)
            texts.Sentry.captureMessage('[Telegram] File was zero bytes')
          }
          texts.log(`[tg] dl attempt ${attempt + 1}/${MAX_DOWNLOAD_ATTEMPTS} for ${filePath}`)
          const dlPromise = this.downloadAsset(filePath, type, id, fileName)
          this.downloadingAssets.set(key, dlPromise)
          try {
            await dlPromise
          } finally {
            this.downloadingAssets.delete(key)
          }
        }
      } catch (err) {
        texts.error('[tg] err media download', err)
        texts.Sentry.captureException(err)
      }
      await sleep(attempt * 100)
    }
    const msg = '[tg] download attempts exhausted for ' + type
    texts.error(msg)
    texts.Sentry.captureMessage(msg)
  }

  handleDeepLink = async (link: string) => {
    const showToast = (text: string) =>
      this.onEvent([{
        type: ServerEventType.TOAST,
        toast: { text },
      }])

    const linkParsed = new URL(link)
    if (linkParsed.host === 't.me' || linkParsed.host === 'tg') { // unused
      const info = await this.client.invoke(new Api.help.GetDeepLinkInfo({ path: link }))
      if (info instanceof Api.help.DeepLinkInfo) {
        if (info.message) showToast(info.message)
      }
      return
    }

    const [, , , , type, threadID, messageID, data] = link.split('/')

    switch (type) {
      case 'inline-query': {
        const [peerID] = resolveId(BigInteger(threadID))
        const sendRes = await this.client.sendMessage(peerID, { message: decodeURIComponent(data) })
        const sentMessage = await this.client.getMessages(peerID, { ids: sendRes.id })
        if (sentMessage?.length) {
          this.emitMessage(sentMessage[0])
        }
        break
      }
      case 'callback': {
        const [peer] = resolveId(BigInteger(threadID))
        const res = await this.client.invoke(new Api.messages.GetBotCallbackAnswer({
          data: Buffer.from(data, 'base64url'),
          peer,
          msgId: +messageID,
        }))
        if (res.message) showToast(res.message)
        break
      }
      case 'join-channel': {
        const resolved = await this.client.invoke(new Api.contacts.ResolveUsername({
          username: data,
        }))
        const chat = resolved?.chats?.[0]
        if (!chat) return
        await this.updateHandler(await this.client.invoke(new Api.channels.JoinChannel({
          channel: chat.id,
        })))
        break
      }
      case 'join-chat': {
        await this.updateHandler(await this.client.invoke(new Api.messages.ImportChatInvite({
          hash: data,
        })))
        break
      }
      default:
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

  getStickerPacks = async (): Promise<PaginatedWithCursors<StickerPack>> => {
    const cachedGetAllStickersHash = this.db.cacheGetHash('GetAllStickers')
    const networkAllStickers = await this.client.invoke(new Api.messages.GetAllStickers(cachedGetAllStickersHash ? { hash: BigInteger(cachedGetAllStickersHash) } : {}))
    const isCached = networkAllStickers instanceof Api.messages.AllStickersNotModified
    const allStickers = isCached ? this.db.cacheGetValue<Api.messages.AllStickers>('GetAllStickers') : networkAllStickers
    if (!isCached) this.db.cacheSet('GetAllStickers', allStickers.hash, networkAllStickers.getBytes())
    return {
      items: await Promise.all(allStickers.sets.map(async ss => {
        const cacheKey = `GetStickerSet_${ss.id}`
        const cachedGetStickerSetHash = this.db.cacheGetHash(cacheKey)
        const networkSet = await this.client.invoke(new Api.messages.GetStickerSet({
          stickerset: new Api.InputStickerSetID({ accessHash: ss.accessHash, id: ss.id }),
          ...(cachedGetStickerSetHash ? { hash: +cachedGetStickerSetHash } : {}),
        }))
        const isCachedSet = networkSet instanceof Api.messages.StickerSetNotModified
        const set = isCachedSet ? this.db.cacheGetValue<Api.messages.StickerSet>(cacheKey) : networkSet
        if (!isCachedSet) this.db.cacheSet(cacheKey, networkSet.set.hash, networkSet.getBytes())
        const stickers = set.documents.map(document => {
          if (document instanceof Api.DocumentEmpty) return
          this.state.mediaStore.set(STICKER_PREFIX + document.id.toString(), new Api.MessageMediaDocument({ document }))
          return this.mapper.mapSticker(document)
        }).filter(Boolean)
        return TelegramMapper.mapStickerPack(ss, stickers)
      })),
      hasMore: false,
      oldestCursor: undefined,
    }
  }
}
