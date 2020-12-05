import { Message, Thread, User, MessageReaction, MessageSeen, ServerEvent, Participant, MessageAttachmentType, ServerEventType, MessageActionType, TextAttributes, TextEntity } from '@textshq/platform-sdk'
import { Chat, Message as TGMessage, ChatMember, TextEntity as TGTextEntity, User as TGUser, FormattedText } from 'airgram'
import { CHAT_TYPE } from '@airgram/constants'

function mapTextAttributes(entities: TGTextEntity[]): TextAttributes {
  if (!entities || entities.length === 0) return undefined
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
        case 'textEntityTypeCode':
        case 'textEntityTypePreCode':
          return { from, to, mono: true }

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
  }
  const setFormattedText = (ft: FormattedText) => {
    mapped.text = ft.text
    mapped.textAttributes = mapTextAttributes(ft.entities)
  }
  switch (msg.content._) {
    case 'messageText':
      setFormattedText(msg.content.text)
      break
    case 'messagePhoto': {
      const file = msg.content.photo.sizes[0]
      setFormattedText(msg.content.caption)
      mapped.attachments.push({
        id: String(file.photo.id),
        type: MessageAttachmentType.IMG,
        srcURL: file.photo.local.path ? `file://${file.photo.local.path}` : `asset://$accountID/${file.photo.id}`,
        size: { width: file.width, height: file.height },
      })
      break
    }
    case 'messageVideo': {
      const file = msg.content.video
      setFormattedText(msg.content.caption)
      mapped.attachments.push({
        id: String(file.video.id),
        type: MessageAttachmentType.VIDEO,
        fileName: file.fileName,
        mimeType: file.mimeType,
        srcURL: file.video.local.path,
        size: { width: file.width, height: file.height },
      })
      break
    }
    case 'messageVideoNote': {
      const file = msg.content.videoNote
      mapped.attachments.push({
        id: String(file.video.id),
        type: MessageAttachmentType.VIDEO,
        srcURL: file.video.local.path,
      })
      break
    }
    case 'messageAudio': {
      const file = msg.content.audio
      setFormattedText(msg.content.caption)
      mapped.attachments.push({
        id: String(file.audio.id),
        type: MessageAttachmentType.AUDIO,
        fileName: file.fileName,
        mimeType: file.mimeType,
        srcURL: file.audio.local.path,
      })
      break
    }
    case 'messageDocument': {
      const file = msg.content.document
      setFormattedText(msg.content.caption)
      mapped.attachments.push({
        id: String(file.document.id),
        type: MessageAttachmentType.UNKNOWN,
        fileName: file.fileName,
        mimeType: file.mimeType,
        srcURL: file.document.local.path,
        fileSize: file.document.size === 0 ? file.document.expectedSize : file.document.size,
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
  let imgURL: string
  if (file) imgURL = file.local.path ? `file://${file.local.path}` : `asset://${accountID}/${file.id}`
  return {
    id: user.id.toString(),
    username: user.username,
    phoneNumber: '+' + user.phoneNumber,
    isVerified: user.isVerified,
    fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    imgURL,
  }
}

export function mapThread(thread: Chat, members: Participant[]): Thread {
  const messages = thread.lastMessage ? [mapMessage(thread.lastMessage)] : []
  const t: Thread = {
    _original: JSON.stringify([thread, members]),
    id: String(thread.id),
    type: (thread.type._ === CHAT_TYPE.chatTypeSecret || thread.type._ === CHAT_TYPE.chatTypePrivate) ? 'single' : 'group',
    timestamp: messages[0]?.timestamp || new Date(),
    isUnread: thread.isMarkedAsUnread || thread.unreadCount > 0,
    isReadOnly: !thread.permissions.canSendMessages,
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
