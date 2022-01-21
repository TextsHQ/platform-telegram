import { Message, Thread, User, MessageAttachmentType, TextAttributes, TextEntity, MessageButton, MessageLink, UserPresenceEvent, ServerEventType, UserPresence, ActivityType, UserActivityEvent, MessageActionType } from '@textshq/platform-sdk'
import { addSeconds } from 'date-fns'
import { Api } from 'telegram/tl'
import type { CustomMessage } from 'telegram/tl/custom/message'
import type { BigInteger } from 'big-integer'
import { getPeerId } from 'telegram/Utils'
import type { Dialog } from 'telegram/tl/custom/dialog'
import { inspect } from 'util'
import { MUTED_FOREVER_CONSTANT } from './constants'
import { getAssetURL, saveAsset } from './util'

function transformOffset(text: string, entities: TextEntity[]) {
  const arr = Array.from(text)
  let strCursor = 0
  let arrCursor = 0
  for (const entity of entities) {
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

function mapTextAttributes(text: string, entities: Api.TypeMessageEntity[]): TextAttributes {
  if (!entities || entities.length === 0) return
  return {
    entities: transformOffset(text, entities.map<TextEntity>(e => {
      const from = e.offset
      const to = e.offset + e.length
      switch (e.className) {
        case 'MessageEntityBold':
          return { from, to, bold: true }

        case 'MessageEntityItalic':
          return { from, to, italic: true }

        case 'MessageEntityStrike':
          return { from, to, strikethrough: true }

        case 'MessageEntityUnderline':
          return { from, to, underline: true }

        case 'MessageEntityPre':
          return { from, to, pre: true }

        case 'MessageEntityCode':
          return { from, to, code: true }

        case 'MessageEntitySpoiler':
          return { from, to, spoiler: true }

        case 'MessageEntityUrl':
        {
          const link = text.slice(from, to)
          return { from, to, link: fixLinkProtocol(link) }
        }

        case 'MessageEntityTextUrl':
        {
          if (e.url) return { from, to, link: e.url }
          break
        }

        case 'MessageEntityMention':
          return { from, to, mentionedUser: { username: text.slice(from, to) } } as TextEntity

        case 'MessageEntityMentionName':
          return {
            from,
            to,
            mentionedUser: { id: String(e.userId) },
          }
        default:
          return { from, to }
      }
      return undefined
    }).filter(Boolean)),
  }
}

function getButtonLinkURL(row: Api.TypeKeyboardButton, accountID: string, chatID: number, messageID: number) {
  switch (row.className) {
    case 'KeyboardButtonUrl':
    case 'KeyboardButtonUrlAuth':
      return row.url
    case 'KeyboardButtonSwitchInline':
      return 'texts://fill-textarea?text=' + encodeURIComponent(row.query)
    case 'KeyboardButtonCallback':
      return `texts://platform-callback/${accountID}/callback/${chatID}/${messageID}/${'data' in row ? row.data : ''}`
    // case 'inlineKeyboardButtonTypeCallbackGame':
    // case 'inlineKeyboardButtonTypeCallbackWithPassword':
    //   return 'texts://platform-callback/' + row.data
    default:
  }
}

export function getMessageButtons(replyMarkup: Api.TypeReplyMarkup, accountID: string, chatID: number, messageID: number) {
  if (!replyMarkup) return
  switch (replyMarkup.className) {
    case 'ReplyInlineMarkup':
      return replyMarkup.rows.flatMap<MessageButton>(rows => rows.buttons.map(row => ({
        label: row.text,
        linkURL: getButtonLinkURL(row, accountID, chatID, messageID),
      })))
    case 'ReplyKeyboardMarkup':
      return replyMarkup.rows.flatMap<MessageButton>(rows => rows.buttons.map(row => {
        if (row.className === 'KeyboardButtonSwitchInline') {
          return {
            label: row.text,
            linkURL: 'texts://fill-textarea?text=' + encodeURIComponent(row.text), // todo: should actually be sent on clicking instantly
          }
        }
        return undefined // todo
      })).filter(Boolean)
    default:
  }
}

const getAssetUrl = async (id: BigInteger, messageId: number) => {
  const assetPath = await getAssetURL(id.toString())
  if (assetPath) return assetPath
  return `asset://$accountID/media/${messageId}/${id}`
}

const getProfilePhotoUrl = async (id: BigInteger) => {
  const assetPath = await getAssetURL(id.toString())
  if (assetPath) return assetPath
  return `asset://$accountID/profile/${id}/${id}`
}
async function mapLinkImg(photo: Api.Photo, messageId: number): Promise<Partial<MessageLink>> {
  if (photo.sizes.length < 1) return
  const photoSize = photo.sizes.slice(-1)[0]
  if (photoSize.className === 'PhotoSize') {
    const { w, h } = photoSize
    const imgSize = { width: w, height: h }
    const file = photo

    const img = await getAssetUrl(file.id, messageId)
    return { img, imgSize }
  }
}

function mapMessageLink(webPage: Api.WebPage, messageId: number) {
  const { url: originalURL, displayUrl, title, description, photo } = webPage
  const link: MessageLink = {
    url: displayUrl,
    originalURL,
    title,
    summary: description,
    img: undefined,
    imgSize: undefined,
  }
  if (photo instanceof Api.Photo) Object.assign(link, mapLinkImg(photo, messageId))
  return link
}

function* getTextFooter(interactionInfo: Api.MessageInteractionCounters) {
  if (interactionInfo?.views) yield `${interactionInfo!.views.toLocaleString()} ${interactionInfo!.views === 1 ? 'view' : 'views'}`
  if (interactionInfo?.forwards) yield `${interactionInfo!.forwards.toLocaleString()} ${interactionInfo!.forwards === 1 ? 'forward' : 'forwards'}`
}

export const mapTextFooter = (interactionInfo: Api.MessageInteractionCounters) => [...getTextFooter(interactionInfo)].join(' · ')

export const getSenderID = (msg: CustomMessage) => msg.senderId

export function mapMessageUpdateText(messageID: string, newContent: Api.Message) {
  if ('text' in newContent) {
    return {
      id: messageID,
      text: newContent.text,
      textAttributes: mapTextAttributes(newContent.text, newContent.entities),
      links: 'webpage' in newContent.media && newContent.media.webpage instanceof Api.WebPage
        ? [mapMessageLink(newContent.media.webpage, Number(messageID))]
        : undefined,
    }
  }
}

function mapCallReason(discardReason: Api.TypePhoneCallDiscardReason) {
  if (discardReason instanceof Api.PhoneCallDiscardReasonMissed) {
    return 'Missed'
  } if (discardReason instanceof Api.PhoneCallDiscardReasonBusy) {
    return 'Declined'
  } if (discardReason instanceof Api.PhoneCallDiscardReasonDisconnect) {
    return 'Disconnected'
  } if (discardReason instanceof Api.PhoneCallDiscardReasonHangup) {
    return 'Hung up'
  }
  return ''
}
export async function mapMessage(msg: CustomMessage, accountID: string) {
  const mapped: Message = {
    _original: inspect(msg),
    id: String(msg.id),
    timestamp: new Date(msg.date * 1000),
    editedTimestamp: msg.editDate ? new Date(msg.editDate * 1000) : undefined,
    text: undefined,
    forwardedCount: msg.forwards,
    textAttributes: undefined,
    senderID: String(getSenderID(msg)),
    isSender: msg.out,
    attachments: undefined,
    linkedMessageID: msg.replyTo ? String(msg.replyToMsgId) : undefined,
    buttons: getMessageButtons(msg.replyMarkup, accountID, msg.chatId.toJSNumber(), msg.id),
    expiresInSeconds: msg.ttlPeriod,
  }
  const setFormattedText = (msgText: string, msgEntities: Api.TypeMessageEntity[]) => {
    mapped.text = msgText
    mapped.textAttributes = mapTextAttributes(msgText, msgEntities)
  }
  const pushSticker = async (sticker: Api.Document, messageId : number) => {
    const sizeAttribute = sticker.attributes.find(a => a.className === 'DocumentAttributeImageSize')?.[0]
    const size = sizeAttribute ? { width: sizeAttribute.w, height: sizeAttribute.h } : undefined
    const animatedAttributes = sticker.attributes.find(a => a.className === 'DocumentAttributeAnimated')
    mapped.attachments = mapped.attachments || []
    mapped.attachments.push({
      id: sticker.id.toString(),
      srcURL: await getAssetUrl(sticker.id, messageId),
      mimeType: animatedAttributes ? 'image/tgs' : undefined,
      type: MessageAttachmentType.IMG,
      isGif: true,
      isSticker: true,
      size,
      extra: {
      },
    })
  }

  if (msg.text) {
    setFormattedText(msg.rawText, msg.entities)
    if (msg.webPreview) {
      mapped.links = [mapMessageLink(msg.webPreview, msg.id)]
    }
  } if (msg.photo instanceof Api.Photo) {
    const { photo } = msg
    mapped.attachments = mapped.attachments || []
    if (photo.sizes[0].className === 'PhotoSize') {
      mapped.attachments.push({
        id: String(photo.id),
        srcURL: await getAssetUrl(photo.id, msg.id),
        type: MessageAttachmentType.IMG,
        size: photo.sizes ? { width: photo.sizes[0].w, height: photo.sizes[0].h } : undefined,
      })
    }
  } if (msg.video instanceof Api.Document) {
    const { video } = msg
    mapped.attachments = mapped.attachments || []
    mapped.attachments.push({
      id: String(video.id),
      srcURL: await getAssetUrl(video.id, msg.id),
      type: MessageAttachmentType.VIDEO,
      fileName: video.accessHash.toString(),
      mimeType: video.mimeType,
      size: video.videoThumbs ? { width: video.videoThumbs[0].w, height: video.videoThumbs[0].h } : undefined,
    })
  } if (msg.audio instanceof Api.Document) {
    const { audio } = msg
    mapped.attachments = mapped.attachments || []
    mapped.attachments.push({
      id: String(audio.id),
      srcURL: await getAssetUrl(audio.id, msg.id),
      type: MessageAttachmentType.AUDIO,
      fileName: audio.accessHash.toString(),
      mimeType: audio.mimeType,
    })
  } if (msg.document instanceof Api.Document) {
    const { document } = msg
    mapped.attachments = mapped.attachments || []
    const fileName = (document.attributes.find(f => f instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename)?.fileName
      ?? document.accessHash.toString()
    mapped.attachments.push({
      id: String(document.id),
      type: MessageAttachmentType.UNKNOWN,
      srcURL: await getAssetUrl(document.id, msg.id),
      fileName,
      mimeType: document.mimeType,
      fileSize: document.size,
    })
  } if (msg.videoNote instanceof Api.Document) {
    const { videoNote } = msg
    mapped.extra = { ...mapped.extra, className: 'telegram-video-note' }
    mapped.attachments = mapped.attachments || []
    mapped.attachments.push({
      id: String(videoNote.id),
      srcURL: await getAssetUrl(videoNote.id, msg.id),
      type: MessageAttachmentType.VIDEO,
    })
  } if (msg.voice instanceof Api.Document) {
    const { voice } = msg
    mapped.attachments = mapped.attachments || []
    mapped.attachments.push({
      id: String(voice.id),
      srcURL: await getAssetUrl(voice.id, msg.id),
      type: MessageAttachmentType.AUDIO,
    })
  } if (msg.gif instanceof Api.Document) {
    const animation = msg.gif
    mapped.attachments = mapped.attachments || []
    const size = animation.thumbs[0] as Api.PhotoSize
    mapped.attachments.push({
      id: String(animation.id),
      srcURL: await getAssetUrl(animation.id, msg.id),
      type: MessageAttachmentType.VIDEO,
      isGif: true,
      fileName: animation.accessHash.toString(),
      mimeType: animation.mimeType,
      size: { width: size.w, height: size.h },
    })
  } if (msg.sticker instanceof Api.Document) {
    pushSticker(msg.sticker, msg.id)
  } else if (msg.contact) {
    const { contact } = msg
    mapped.attachments = mapped.attachments || []
    mapped.attachments.push({
      id: String(contact.userId),
      type: MessageAttachmentType.UNKNOWN,
      data: Buffer.from(contact.vcard, 'utf-8'),
      fileName: ([contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phoneNumber) + '.vcf',
    })
  } if (msg.geo instanceof Api.GeoPoint) {
    const location = msg.geo
    if (mapped.textHeading) mapped.textHeading += '\n'
    else mapped.textHeading = ''
    mapped.textHeading += '📍 Location'
    mapped.text = `https://www.google.com/maps?q=${location.lat},${location.long}`
  } else if (msg.venue instanceof Api.MessageMediaVenue) {
    const { venue } = msg
    mapped.textHeading = '📍 Venue'
    mapped.text = [
      venue.title,
      venue.address,
      venue.geo instanceof Api.GeoPoint ? `https://www.google.com/maps?q=${venue.geo.lat},${venue.geo.long}` : '',
    ].join('\n')
  } if (msg.dice instanceof Api.MessageMediaDice) {
    /* TODO
      if (mapped.textHeading) mapped.textHeading += '\n'
      else mapped.textHeading = ''
      if (msg.dice.emoticon) {
        mapped.extra = { ...mapped.extra, className: 'telegram-dice' }
      } else {
        mapped.text = msg.dice.emoticon
        switch (msg.dice.emoticon) {
          case 'diceStickersRegular':
            mapped.textHeading = `Dice: ${msg.dice.value}`
            break
          case 'diceStickersSlotMachine':
            mapped.textHeading = `Slot Machine: ${msg.dice.value}`
            break
          default:
            break
        }
      }
      switch (msg.dice.emoticon) {
        case 'diceStickersRegular':
          pushSticker(msg.dice, false, 100, 100)
          break
        case 'diceStickersSlotMachine':
          pushSticker(msg.content.finalState.background, false)
          pushSticker(msg.content.finalState.leftReel, false)
          pushSticker(msg.content.finalState.centerReel, false)
          pushSticker(msg.content.finalState.rightReel, false)
          pushSticker(msg.content.finalState.lever, false)
        default:
      }
      */
  } if (msg.poll instanceof Api.MessageMediaPoll) {
    const { poll } = msg
    mapped.textHeading = `${poll.poll.publicVoters ? 'Anonymous ' : ''}Poll

${poll.results.results.map(result => [poll.poll.answers.find(a => a.option === result.option).text, result.chosen ? '✔️' : '', `— ${(result.voters / poll.results.totalVoters) * 100}%`, `(${result.voters})`].filter(Boolean).join('\t')).join('\n')}`
  } if (msg instanceof Api.MessageService) {
    if (msg.action instanceof Api.MessageActionPhoneCall) {
      mapped.textHeading = [
        `${msg.action.video ? '🎥 Video ' : '📞 '}Call`,
        msg.action.duration ? msg.action.duration.toString() : '',
        mapCallReason(msg.action.reason),
      ].filter(Boolean).join('\n')
    } else if (msg.action instanceof Api.MessageActionPinMessage) {
      mapped.text = '{{sender}} pinned a message'
      mapped.isAction = true
      mapped.parseTemplate = true
    } else if (msg.action instanceof Api.MessageActionContactSignUp) {
      mapped.text = '{{sender}} joined Telegram'
      mapped.isAction = true
      mapped.parseTemplate = true
    } else if (msg.action instanceof Api.MessageActionChatEditTitle) {
      mapped.text = `{{sender}} changed the thread title to "${msg.action.title}"`
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.THREAD_TITLE_UPDATED,
        title: msg.action.title,
        actorParticipantID: mapped.senderID,
      }
    } else if (msg.action instanceof Api.MessageActionChatAddUser) {
      mapped.text = `${msg.action.users.map(m => `{{${m}}}`).join(', ')} joined the group`
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.THREAD_PARTICIPANTS_ADDED,
        participantIDs: msg.action.users.map(num => String(num)),
        actorParticipantID: undefined,
      }
    } else {
      mapped.textHeading = 'Unsupported Telegram message'
    }
  }
  return mapped
  /*
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
      case 'messagePaymentSuccessful':
        mapped.text = `You have successfully transfered ${msg.content.currency} ${msg.content.totalAmount}`
        mapped.linkedMessageID = String(msg.content.invoiceMessageId)
        mapped.isAction = true
        mapped.parseTemplate = true
        break
      }
      */
}

export async function mapUser(user: Api.User): Promise<User> {
  if (!user) return
  const imgURL = await getProfilePhotoUrl(user.id)
  return {
    id: user.id.toString(),
    username: user.username,
    phoneNumber: user.phone ? '+' + user.phone : undefined,
    isVerified: user.verified,
    fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    imgURL,
  }
}

export function mapUserPresence(userId: number, status: Api.TypeUserStatus): UserPresenceEvent {
  const presence: UserPresence = {
    userID: userId.toString(),
    lastActive: null,
    status: null,
  }
  const oneDay = 24 * 3600 * 1000
  if (status instanceof Api.UserStatusOnline) {
    presence.status = 'online'
    presence.lastActive = new Date()
  } else if (status instanceof Api.UserStatusRecently) {
    presence.status = 'online'
    presence.lastActive = new Date(Date.now() - 3600 * 1000)
  } else if (status instanceof Api.UserStatusLastWeek) {
    presence.lastActive = new Date(Date.now() - 7 * oneDay)
  } else if (status instanceof Api.UserStatusLastMonth) {
    presence.lastActive = new Date(Date.now() - 30 * oneDay)
  }
  return {
    type: ServerEventType.USER_PRESENCE_UPDATED,
    presence,
  }
}

export const mapMuteFor = (seconds: number) => {
  if (seconds >= MUTED_FOREVER_CONSTANT) return 'forever'
  if (seconds === 0) return
  return addSeconds(new Date(), seconds)
}

export async function mapThread(dialog: Dialog, messages: Message[], members: Api.User[]): Promise<Thread> {
  const imgFile = await getProfilePhotoUrl(dialog.id)
  const t: Thread = {
    _original: inspect(dialog),
    id: String(getPeerId(dialog.id)),
    type: dialog instanceof Api.Chat ? 'single' : 'group',
    timestamp: messages[0]?.timestamp,
    isUnread: dialog.unreadCount !== 0,
    isReadOnly: false,
    lastReadMessageID: String(Math.max(dialog.dialog.readInboxMaxId, dialog.dialog.readOutboxMaxId)),
    mutedUntil: mapMuteFor(dialog.dialog.notifySettings.muteUntil),
    imgURL: imgFile,
    title: dialog.title,
    messages: {
      hasMore: true,
      oldestCursor: messages[0]?.id || '',
      items: messages,
    },
    participants: {
      hasMore: false,
      items: await Promise.all(members.map(m => mapUser(m))),
    },
  }
  return t
}

export const mapMessages = async (messages: Api.Message[], accountID: string) =>
  Promise.all(messages.map(m => mapMessage(m, accountID)))

// https://github.com/evgeny-nadymov/telegram-react/blob/afd90f19b264895806359c23f985edccda828aca/src/Utils/Chat.js#L445
export function mapUserAction(update: Api.UpdateUserTyping): UserActivityEvent {
  // TODO
  const threadID = update.userId.toString()
  const participantID = update.userId.toString()
  const customActivity = (customLabel: string): UserActivityEvent => ({
    type: ServerEventType.USER_ACTIVITY,
    threadID,
    participantID,
    activityType: ActivityType.CUSTOM,
    customLabel,
    durationMs: 10 * 60_000, // 10 mins
  })
  if (update.action instanceof Api.SendMessageTypingAction) {
    return {
      type: ServerEventType.USER_ACTIVITY,
      threadID,
      participantID,
      activityType: ActivityType.TYPING,
      durationMs: 3 * 60_000, // 3 mins
    }
  }
  if (update.action instanceof Api.SendMessageRecordAudioAction) {
    return {
      type: ServerEventType.USER_ACTIVITY,
      threadID,
      participantID,
      activityType: ActivityType.RECORDING_VOICE,
      durationMs: 5 * 60_000, // 5 mins
    }
  }
  if (update.action instanceof Api.SendMessageRecordVideoAction) {
    return {
      type: ServerEventType.USER_ACTIVITY,
      threadID,
      participantID,
      activityType: ActivityType.RECORDING_VIDEO,
      durationMs: 10 * 60_000, // 10 mins
    }
  }
  if (update.action instanceof Api.SendMessageChooseContactAction) { return customActivity('choosing contact') }
  if (update.action instanceof Api.SendMessageGeoLocationAction) { return customActivity('choosing location') }
  if (update.action instanceof Api.SendMessageGamePlayAction) return customActivity('playing a game')
  if (update.action instanceof Api.SendMessageUploadDocumentAction) return customActivity('uploading a document' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
  if (update.action instanceof Api.SendMessageUploadPhotoAction) return customActivity('uploading a photo' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
  if (update.action instanceof Api.SendMessageUploadVideoAction) return customActivity('uploading a video' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
  if (update.action instanceof Api.SendMessageUploadAudioAction) return customActivity('uploading a voice note' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
  if (update.action instanceof Api.SendMessageCancelAction) {
    return {
      type: ServerEventType.USER_ACTIVITY,
      threadID,
      participantID,
      activityType: ActivityType.NONE,
    }
  }
}

export function idFromPeer(peer: Api.TypePeer): number {
  if (peer instanceof Api.PeerChat) { return peer.chatId.toJSNumber() }
  if (peer instanceof Api.PeerChannel) { return peer.channelId.toJSNumber() }
  return peer.userId.toJSNumber()
}
