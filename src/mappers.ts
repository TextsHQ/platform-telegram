import { orderBy } from 'lodash'
import { Message, Thread, MessageReaction, MessageSeen, ServerEvent, Participant, MessageAttachmentType, ServerEventType, MessageActionType } from '@textshq/platform-sdk'
import { Chat, Message as TGMessage, ChatMember } from 'airgram'
import { CHAT_TYPE } from '@airgram/constants'

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
    senderID: String(senderID),
    isSender: msg.isOutgoing,
    attachments: [],
    reactions: [],
    isErrored: msg.sendingState?._ === 'messageSendingStateFailed',
    isDelivered: msg.sendingState?._ === 'messageSendingStatePending',
    linkedMessageID: msg.replyToMessageId ? String(msg.replyToMessageId) : undefined,
  }
  switch (msg.content._) {
    case 'messageText':
      mapped.text = msg.content.text.text
      break
    case 'messagePhoto': {
      const file = msg.content.photo.sizes[0]
      mapped.text = msg.content.caption.text
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
      mapped.text = msg.content.caption.text
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
      mapped.text = msg.content.caption.text
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
      mapped.text = msg.content.caption.text
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
      mapped.text = `Chat title changed to ${msg.content.title}`
      mapped.isAction = true
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
  }
  return mapped
}

function mapParticipant(member: ChatMember) {
  const p: Participant = {
    id: String(member.userId),
  }
  return p
}

export function mapThread(thread: Chat, members: Participant[]): Thread {
  // console.log(thread, JSON.stringify(thread))
  const messages = thread.lastMessage ? [mapMessage(thread.lastMessage)] : []
  const t: Thread = {
    id: String(thread.id),
    type: ([CHAT_TYPE.chatTypePrivate, CHAT_TYPE.chatTypeSecret] as string[]).includes(thread.type._) ? 'single' : 'group',
    timestamp: messages[0]?.timestamp,
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
