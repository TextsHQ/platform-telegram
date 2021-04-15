import { Message, Thread, User, MessageAttachmentType, MessageActionType, TextAttributes, TextEntity, MessageButton, MessageLink, UserPresenceEvent, ServerEventType, UserPresence } from '@textshq/platform-sdk'
import { CHAT_TYPE, USER_STATUS } from '@airgram/constants'
import { formatDuration } from 'date-fns'
import type { Chat, Message as TGMessage, TextEntity as TGTextEntity, User as TGUser, FormattedText, File, ReplyMarkupUnion, InlineKeyboardButtonTypeUnion, Photo, WebPage, UserStatusUnion, Sticker, CallDiscardReasonUnion } from 'airgram'

/**
 * The offset of TGTextEntity is in UTF-16 code units, transform it to be in
 * characters. An example: for text "👍@user👍"
 *   before: { from: 2, to: 7 }
 *   after: { from: 1, to: 6 }
 */
function transformOffset(text: string, entities: TextEntity[]) {
  const arr = Array.from(text)
  let strCursor = 0
  let arrCursor = 0
  for (let entity of entities) {
    const { from, to } = entity
    while (strCursor < from) {
      strCursor += arr[arrCursor++].length
    }
    entity.from = arrCursor
    entity.to = entity.from + Array.from(text.slice(from, to)).length
  }
  return entities
}

function fixLinkProtocol(link: string) {
  try {
    new URL(link)
    return link
  } catch (error) {
    if (error.code === 'ERR_INVALID_URL') return 'http://' + link
    throw error
  }
}

function mapTextAttributes(text: string, entities: TGTextEntity[]): TextAttributes {
  if (!entities || entities.length === 0) return
  return {
    entities: transformOffset(text, entities.map<TextEntity>(e => {
      const from = e.offset
      const to = e.offset + e.length
      switch (e.type._) {
        case 'textEntityTypeBold':
          return { from, to, bold: true }

        case 'textEntityTypeItalic':
          return { from, to, italic: true }

        case 'textEntityTypeStrikethrough':
          return { from, to, strikethrough: true }

        case 'textEntityTypeUnderline':
          return { from, to, underline: true }

        case 'textEntityTypePre':
          return { from, to, pre: true }

        case 'textEntityTypeCode':
          return { from, to, code: true }

        case 'textEntityTypePreCode':
          return { from, to, codeLanguage: e.type.language }

        case 'textEntityTypeUrl': {
          const link = text.slice(from, to)
          return { from, to, link: fixLinkProtocol(link) }
        }

        case 'textEntityTypeTextUrl':
          if (e.type.url) return { from, to, link: e.type.url }
          break

        case 'textEntityTypeMention':
          return { from, to, mentionedUser: { username: text.slice(from, to) } } as TextEntity

        case 'textEntityTypeMentionName':
          return {
            from,
            to,
            mentionedUser: { id: String(e.type.userId) },
          }
      }
      return undefined
    }).filter(Boolean)),
  }
}

function getButtonLinkURL(row: InlineKeyboardButtonTypeUnion) {
  switch (row._) {
    case 'inlineKeyboardButtonTypeUrl':
      return row.url
    case 'inlineKeyboardButtonTypeSwitchInline':
      return 'texts://fill-textarea?text=' + encodeURIComponent(row.query)
  }
}

function getButtons(replyMarkup: ReplyMarkupUnion) {
  if (!replyMarkup) return
  switch (replyMarkup._) {
    case 'replyMarkupInlineKeyboard':
      return replyMarkup.rows.flatMap<MessageButton>(rows => rows.map(row => ({
        label: row.text,
        linkURL: getButtonLinkURL(row.type),
      })))
    case 'replyMarkupShowKeyboard':
      return replyMarkup.rows.flatMap<MessageButton>(rows => rows.map(row => {
        if (row.type._ === 'keyboardButtonTypeText') {
          return {
            label: row.text,
            linkURL: 'texts://fill-textarea?text=' + encodeURIComponent(row.text), // todo: should actually be sent on clicking instantly
          }
        }
        return undefined // todo
      })).filter(Boolean)
  }
}

const getAssetURL = (file: File) =>
  (file.local.path ? `file://${file.local.path}` : `asset://$accountID/file/${file.id}`)

const getAssetURLWithAccountID = (accountID: string, file: File) =>
  (file.local.path ? `file://${file.local.path}` : `asset://${accountID}/file/${file.id}`)

function mapLinkImg(photo: Photo): Partial<MessageLink> {
  if (photo.sizes.length < 1) return
  const photoSize = photo.sizes.slice(-1)[0] // last image should be biggest
  const { width, height } = photoSize
  const imgSize = { width, height }
  const file = photoSize.photo
  const img = getAssetURL(file)
  return { img, imgSize }
}

function mapMessageLink(webPage: WebPage) {
  const { url, displayUrl, title, description, photo } = webPage
  const link: MessageLink = {
    url: displayUrl,
    originalURL: url,
    title,
    summary: description.text,
    img: undefined,
    imgSize: undefined,
  }
  if (photo) Object.assign(link, mapLinkImg(photo))
  return link
}

function* getTextFooter(msg: TGMessage) {
  if (msg.interactionInfo?.viewCount) yield `${msg.interactionInfo!.viewCount.toLocaleString()} ${msg.interactionInfo!.viewCount === 1 ? 'view' : 'views'}`
  if (msg.interactionInfo?.forwardCount) yield `${msg.interactionInfo!.forwardCount.toLocaleString()} ${msg.interactionInfo!.forwardCount === 1 ? 'forward' : 'forwards'}`
}

function getSenderID(msg: TGMessage) {
  if (msg.sender._ === 'messageSenderUser') return msg.sender.userId
  return msg.sender.chatId === msg.chatId ? '$thread' : msg.sender.chatId
}

export function mapMessage(msg: TGMessage) {
  const mapped: Message = {
    _original: JSON.stringify(msg),
    id: String(msg.id),
    timestamp: new Date(msg.date * 1000),
    editedTimestamp: msg.editDate ? new Date(msg.editDate * 1000) : undefined,
    text: undefined,
    forwardedCount: msg.forwardInfo?.date ? 1 : undefined,
    textFooter: [...getTextFooter(msg)].join(' · '),
    textAttributes: undefined,
    senderID: String(getSenderID(msg)),
    isSender: msg.isOutgoing,
    attachments: undefined,
    isErrored: msg.sendingState?._ === 'messageSendingStateFailed',
    isDelivered: msg.sendingState?._ === 'messageSendingStatePending',
    linkedMessageID: msg.replyToMessageId ? String(msg.replyToMessageId) : undefined,
    buttons: getButtons(msg.replyMarkup),
    expiresInSeconds: msg.ttlExpiresIn,
  }
  const setFormattedText = (ft: FormattedText) => {
    mapped.text = ft.text
    mapped.textAttributes = mapTextAttributes(ft.text, ft.entities)
  }
  const pushSticker = (sticker: Sticker, loop: boolean = undefined) => {
    mapped.attachments = mapped.attachments || []
    mapped.attachments.push({
      id: String(sticker.sticker.id),
      srcURL: getAssetURL(sticker.sticker),
      mimeType: 'image/tgs',
      type: MessageAttachmentType.IMG,
      isGif: true,
      isSticker: true,
      size: { width: sticker.width, height: sticker.height },
      extra: {
        loop,
      },
    })
  }
  switch (msg.content._) {
    case 'messageText':
      setFormattedText(msg.content.text)
      if (msg.content.webPage) {
        mapped.links = [mapMessageLink(msg.content.webPage)]
      }
      break

    case 'messagePhoto': {
      setFormattedText(msg.content.caption)
      const photo = msg.content.photo.sizes.slice(-1)[0]
      mapped.attachments = mapped.attachments || []
      mapped.attachments.push({
        id: String(photo.photo.id),
        srcURL: getAssetURL(photo.photo),
        type: MessageAttachmentType.IMG,
        size: { width: photo.width, height: photo.height },
      })
      break
    }
    case 'messageVideo': {
      setFormattedText(msg.content.caption)
      const { video } = msg.content
      mapped.attachments = mapped.attachments || []
      mapped.attachments.push({
        id: String(video.video.id),
        srcURL: getAssetURL(video.video),
        type: MessageAttachmentType.VIDEO,
        fileName: video.fileName,
        mimeType: video.mimeType,
        size: { width: video.width, height: video.height },
      })
      break
    }
    case 'messageAudio': {
      setFormattedText(msg.content.caption)
      const { audio } = msg.content
      mapped.attachments = mapped.attachments || []
      mapped.attachments.push({
        id: String(audio.audio.id),
        srcURL: getAssetURL(audio.audio),
        type: MessageAttachmentType.AUDIO,
        fileName: audio.fileName,
        mimeType: audio.mimeType,
      })
      break
    }
    case 'messageDocument': {
      setFormattedText(msg.content.caption)
      const { document } = msg.content
      mapped.attachments = mapped.attachments || []
      mapped.attachments.push({
        id: String(document.document.id),
        type: MessageAttachmentType.UNKNOWN,
        srcURL: getAssetURL(document.document),
        fileName: document.fileName,
        mimeType: document.mimeType,
        fileSize: document.document.size === 0 ? document.document.expectedSize : document.document.size,
      })
      break
    }
    case 'messageVideoNote': {
      const { videoNote } = msg.content
      mapped.extra = { ...mapped.extra, className: 'telegram-video-note' }
      mapped.attachments = mapped.attachments || []
      mapped.attachments.push({
        id: String(videoNote.video.id),
        srcURL: getAssetURL(videoNote.video),
        type: MessageAttachmentType.VIDEO,
      })
      break
    }
    case 'messageVoiceNote': {
      setFormattedText(msg.content.caption)
      const { voiceNote } = msg.content
      mapped.attachments = mapped.attachments || []
      mapped.attachments.push({
        id: String(voiceNote.voice.id),
        srcURL: getAssetURL(voiceNote.voice),
        type: MessageAttachmentType.AUDIO,
      })
      break
    }
    case 'messageAnimation': {
      setFormattedText(msg.content.caption)
      const { animation } = msg.content
      mapped.attachments = mapped.attachments || []
      mapped.attachments.push({
        id: String(animation.animation.id),
        srcURL: getAssetURL(animation.animation),
        type: MessageAttachmentType.VIDEO,
        isGif: true,
        fileName: animation.fileName,
        mimeType: animation.mimeType,
        size: { width: animation.width, height: animation.height },
      })
      break
    }
    case 'messageSticker': {
      const { sticker } = msg.content
      pushSticker(sticker)
      break
    }
    case 'messageContact': {
      const { contact } = msg.content
      mapped.attachments = mapped.attachments || []
      mapped.attachments.push({
        id: String(contact.userId),
        type: MessageAttachmentType.UNKNOWN,
        data: Buffer.from(contact.vcard, 'utf-8'),
        fileName: ([contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phoneNumber) + '.vcf',
      })
      break
    }
    case 'messageLocation': {
      const { location } = msg.content
      if (mapped.textHeading) mapped.textHeading += '\n'
      else mapped.textHeading = ''
      mapped.textHeading += msg.content.livePeriod ? '📍 Live Location' : '📍 Location'
      mapped.text = `https://www.google.com/maps?q=${location.latitude},${location.longitude}`
      break
    }
    case 'messageDice':
      if (mapped.textHeading) mapped.textHeading += '\n'
      else mapped.textHeading = ''
      if (msg.content.finalState?._) {
        mapped.extra = { ...mapped.extra, className: 'telegram-dice' }
      } else {
        mapped.text = msg.content.emoji
        switch (msg.content.initialState?._) {
          case 'diceStickersRegular':
            mapped.textHeading = `Dice: ${msg.content.value}`
            break
          case 'diceStickersSlotMachine':
            mapped.textHeading = `Slot Machine: ${msg.content.value}`
            break
        }
      }
      switch (msg.content.finalState?._) {
        case 'diceStickersRegular':
          pushSticker(msg.content.finalState.sticker, false)
          break
        case 'diceStickersSlotMachine':
          pushSticker(msg.content.finalState.background, false)
          pushSticker(msg.content.finalState.leftReel, false)
          pushSticker(msg.content.finalState.centerReel, false)
          pushSticker(msg.content.finalState.rightReel, false)
          pushSticker(msg.content.finalState.lever, false)
          break
      }
      break
    case 'messagePoll': {
      const { poll } = msg.content
      mapped.textHeading = `${poll.isAnonymous ? 'Anonymous ' : ''}Poll

${poll.options.map(option => [option.text, option.isChosen ? '✔️' : '', `— ${option.votePercentage}%`, `(${option.voterCount})`].filter(Boolean).join('\t')).join('\n')}`
      break
    }

    case 'messageCall':
      function mapReason(discardReason: CallDiscardReasonUnion) {
        switch (discardReason._) {
          case 'callDiscardReasonMissed':
            return 'Missed'
          case 'callDiscardReasonDeclined':
            return 'Declined'
          case 'callDiscardReasonDisconnected':
            return 'Disconnected'
          case 'callDiscardReasonHungUp':
            return 'Hung up'
        }
        return ''
      }
      mapped.textHeading = [
        `${msg.content.isVideo ? '🎥 Video ' : '📞 '}Call`,
        msg.content.duration ? formatDuration({ seconds: msg.content.duration }) : '',
        mapReason(msg.content.discardReason),
      ].filter(Boolean).join('\n')
      break

    case 'messagePinMessage':
      mapped.text = '{{sender}} pinned a message'
      mapped.isAction = true
      mapped.parseTemplate = true
      break
    case 'messageContactRegistered':
      mapped.text = '{{sender}} joined Telegram'
      mapped.isAction = true
      mapped.parseTemplate = true
      break
    case 'messageChatChangeTitle':
      mapped.text = `{{sender}} changed the thread title to "${msg.content.title}"`
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.THREAD_TITLE_UPDATED,
        title: msg.content.title,
        actorParticipantID: mapped.senderID,
      }
      break
    case 'messageChatAddMembers':
      mapped.text = `${msg.content.memberUserIds.map(m => `{{${m}}}`).join(', ')} joined the group`
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.THREAD_PARTICIPANTS_ADDED,
        participantIDs: msg.content.memberUserIds.map(num => String(num)),
        actorParticipantID: undefined,
      }
      break
    case 'messageChatDeleteMember':
      mapped.text = `{{${msg.content.userId}}} left the group`
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.THREAD_PARTICIPANTS_REMOVED,
        participantIDs: [String(msg.content.userId)],
        actorParticipantID: undefined,
      }
      break
    case 'messageChatJoinByLink':
      mapped.text = '{{sender}} joined the group via invite link'
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.THREAD_PARTICIPANTS_ADDED,
        participantIDs: [mapped.senderID],
        actorParticipantID: undefined,
      }
      break
    case 'messageChatChangePhoto':
      mapped.text = '{{sender}} updated the group photo'
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.THREAD_IMG_CHANGED,
        actorParticipantID: mapped.senderID,
      }
      break
    case 'messageChatDeletePhoto':
      mapped.text = '{{sender}} deleted the group photo'
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.THREAD_IMG_CHANGED,
        actorParticipantID: mapped.senderID,
      }
      break
    case 'messageBasicGroupChatCreate':
    case 'messageSupergroupChatCreate':
      mapped.text = `{{sender}} created the group "${msg.content.title}"`
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.GROUP_THREAD_CREATED,
        actorParticipantID: mapped.senderID,
        title: msg.content.title,
      }
      break
    case 'messageChatUpgradeFrom':
      mapped.text = `{{sender}} created the group "${msg.content.title}"`
      mapped.isAction = true
      mapped.parseTemplate = true
      break
    case 'messageExpiredPhoto':
      mapped.text = '{{sender}} sent a self-destructing photo.'
      mapped.isAction = true
      mapped.parseTemplate = true
      break
    case 'messageExpiredVideo':
      mapped.text = '{{sender}} sent a self-destructing video.'
      mapped.isAction = true
      mapped.parseTemplate = true
      break
    case 'messageCustomServiceAction':
      mapped.text = msg.content.text
      mapped.isAction = true
      mapped.parseTemplate = true
      break
  }
  return mapped
}

export function mapUser(user: TGUser, accountID: string): User {
  if (!user) return
  const file = user.profilePhoto?.small
  const imgURL = file ? getAssetURLWithAccountID(accountID, file) : undefined
  return {
    id: user.id.toString(),
    username: user.username,
    phoneNumber: user.phoneNumber ? '+' + user.phoneNumber : undefined,
    isVerified: user.isVerified,
    fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    imgURL,
  }
}

export function mapUserPresence(userId: number, status: UserStatusUnion): UserPresenceEvent {
  const presence: UserPresence = {
    userID: userId.toString(),
    isActive: false,
    lastActive: null,
  }
  const oneDay = 24 * 3600 * 1000
  switch (status._) {
    case USER_STATUS.userStatusOnline:
      presence.isActive = true
      presence.lastActive = new Date()
      break
    case USER_STATUS.userStatusRecently:
      presence.isActive = true
      presence.lastActive = new Date(Date.now() - 3600 * 1000)
      break
    // case USER_STATUS.userStatusOffline:
    //   presence.lastActive = new Date(status.wasOnline * 1000)
    //   break
    case USER_STATUS.userStatusLastWeek:
      presence.lastActive = new Date(Date.now() - 7 * oneDay)
      break
    case USER_STATUS.userStatusLastMonth:
      presence.lastActive = new Date(Date.now() - 30 * oneDay)
      break
  }
  return {
    type: ServerEventType.USER_PRESENCE_UPDATED,
    presence,
  }
}

export function mapThread(thread: Chat, members: TGUser[], accountID: string): Thread {
  const messages = thread.lastMessage ? [mapMessage(thread.lastMessage)] : []
  const imgFile = thread.photo?.small
  const t: Thread = {
    _original: JSON.stringify([thread, members]),
    id: String(thread.id),
    type: (thread.type._ === CHAT_TYPE.chatTypeSecret || thread.type._ === CHAT_TYPE.chatTypePrivate) ? 'single' : 'group',
    timestamp: messages[0]?.timestamp || new Date(),
    isUnread: thread.isMarkedAsUnread || thread.unreadCount > 0,
    isReadOnly: !thread.permissions.canSendMessages,
    imgURL: imgFile ? getAssetURLWithAccountID(accountID, imgFile) : undefined,
    title: thread.title,
    messages: {
      hasMore: true,
      oldestCursor: messages[0]?.id || '',
      items: messages,
    },
    participants: {
      hasMore: false,
      items: members.map(m => mapUser(m, accountID)),
    },
  }
  return t
}

export const mapMessages = (messages: TGMessage[]) => messages.map(mapMessage)
