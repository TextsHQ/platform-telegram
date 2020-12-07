import { Message, Thread, User, Participant, MessageAttachmentType, MessageActionType, TextAttributes, TextEntity, MessageButton, MessageLink, Size } from '@textshq/platform-sdk'
import { Chat, Message as TGMessage, TextEntity as TGTextEntity, User as TGUser, FormattedText, File, ReplyMarkupUnion, InlineKeyboardButtonTypeUnion, Photo, WebPage } from 'airgram'
import { CHAT_TYPE } from '@airgram/constants'

function mapTextAttributes(entities: TGTextEntity[]): TextAttributes {
  if (!entities || entities.length === 0) return
  return {
    entities: entities.map<TextEntity>(e => {
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

        case 'textEntityTypeTextUrl':
          if (e.type.url) return { from, to, link: e.type.url }
          break

        case 'textEntityTypeMentionName':
          return {
            from,
            to,
            mentionedUser: { id: String(e.type.userId) },
          }
      }
      return undefined
    }).filter(Boolean),
  }
}

function getButtonLinkURL(row: InlineKeyboardButtonTypeUnion) {
  switch (row._) {
    case 'inlineKeyboardButtonTypeUrl':
      return row.url
  }
}

function getButtons(replyMarkup: ReplyMarkupUnion) {
  if (!replyMarkup) return
  if (replyMarkup._ !== 'replyMarkupInlineKeyboard') return
  return replyMarkup.rows.flatMap<MessageButton>(rows => rows.map(row => ({
    label: row.text,
    linkURL: getButtonLinkURL(row.type),
  })))
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

export function mapMessage(msg: TGMessage) {
  const senderID = msg.sender._ === 'messageSenderUser'
    ? msg.sender.userId
    : msg.sender.chatId
  const mapped: Message = {
    _original: JSON.stringify(msg),
    id: String(msg.id),
    timestamp: new Date(msg.date * 1000),
    editedTimestamp: msg.editDate ? new Date(msg.editDate * 1000) : undefined,
    text: undefined,
    textAttributes: undefined,
    senderID: String(senderID),
    isSender: msg.isOutgoing,
    attachments: [],
    reactions: [],
    isErrored: msg.sendingState?._ === 'messageSendingStateFailed',
    isDelivered: msg.sendingState?._ === 'messageSendingStatePending',
    linkedMessageID: msg.replyToMessageId ? String(msg.replyToMessageId) : undefined,
    buttons: getButtons(msg.replyMarkup),
  }
  const setFormattedText = (ft: FormattedText) => {
    mapped.text = ft.text
    mapped.textAttributes = mapTextAttributes(ft.entities)
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
      mapped.attachments.push({
        id: String(sticker.sticker.id),
        srcURL: getAssetURL(sticker.sticker),
        type: MessageAttachmentType.IMG,
        isGif: true,
        size: { width: sticker.width, height: sticker.height },
      })
      break
    }

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
    case 'messageContactRegistered':
      mapped.text = '{{sender}} joined Telegram'
      mapped.isAction = true
      mapped.parseTemplate = true
      break
    case 'messageChatJoinByLink':
      mapped.text = '{{sender}} joined the group via invite link'
      mapped.isAction = true
      mapped.parseTemplate = true
      break
    case 'messageBasicGroupChatCreate':
      mapped.text = `{{sender}} created the group "${msg.content.title}"`
      mapped.isAction = true
      mapped.parseTemplate = true
      mapped.action = {
        type: MessageActionType.GROUP_THREAD_CREATED,
        actorParticipantID: mapped.senderID,
        title: msg.content.title,
      }
  }
  return mapped
}

export function mapUser(user: TGUser, accountID: string): User {
  const file = user.profilePhoto?.small
  const imgURL = file ? getAssetURLWithAccountID(accountID, file) : undefined
  return {
    id: user.id.toString(),
    username: user.username,
    phoneNumber: '+' + user.phoneNumber,
    isVerified: user.isVerified,
    fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    imgURL,
  }
}

export function mapThread(thread: Chat, members: Participant[], accountID: string): Thread {
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
      items: members,
    },
  }
  return t
}

export const mapMessages = (messages: TGMessage[]) => messages.map(mapMessage)
