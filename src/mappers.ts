import { Message, Thread, User, MessageAttachmentType, TextAttributes, TextEntity, MessageButton, MessageLink, UserPresenceEvent, ServerEventType, UserPresence, ActivityType, UserActivityEvent, MessageActionType, MessageReaction, Participant, ServerEvent, texts, MessageBehavior } from '@textshq/platform-sdk'
import { addSeconds } from 'date-fns'
import { range } from 'lodash'
import VCard from 'vcard-creator'
import { Api } from 'telegram/tl'
import mime from 'mime-types'

import type { CustomMessage } from 'telegram/tl/custom/message'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { Entity } from 'telegram/define'

import { getPeerId } from 'telegram/Utils'
import { MUTED_FOREVER_CONSTANT } from './constants'
import { stringifyCircular } from './util'

interface UnmarkedId {
  userId?: bigInt.BigInteger
  chatId?: bigInt.BigInteger
  channelId?: bigInt.BigInteger
}

export function getMarkedId(unmarked: UnmarkedId) {
  if (unmarked.userId) return unmarked.userId.toString()
  if (unmarked.chatId) {
    const str = unmarked.chatId.toString()
    return str.startsWith('-') ? str : `-${str}`
  }
  if (unmarked.channelId) {
    const str = unmarked.channelId.toString()
    return str.startsWith('-100') ? str : `-100${str}`
  }
}
function getUnmarkedId(unmarked: UnmarkedId) {
  if (unmarked.userId) return unmarked.userId.toString()
  if (unmarked.chatId) return unmarked.chatId.toString()
  if (unmarked.channelId) return unmarked.channelId.toString()
}

export default class TelegramMapper {
  constructor(private readonly accountID: string, private readonly me: Api.User) { }

  static* getTextFooter(interactionInfo: Api.MessageInteractionCounters) {
    if (interactionInfo?.views) yield `${interactionInfo!.views.toLocaleString()} ${interactionInfo!.views === 1 ? 'view' : 'views'}`
    if (interactionInfo?.forwards) yield `${interactionInfo!.forwards.toLocaleString()} ${interactionInfo!.forwards === 1 ? 'forward' : 'forwards'}`
  }

  static transformOffset(text: string, entities: TextEntity[]) {
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

  static fixLinkProtocol(link: string) {
    try {
      new URL(link)
      return link
    } catch (error) {
      if (error.code === 'ERR_INVALID_URL') return 'http://' + link
      throw error
    }
  }

  static mapTextAttributes(text: string, entities: Api.TypeMessageEntity[]): TextAttributes | undefined {
    if (!entities || entities.length === 0) return
    return {
      entities: TelegramMapper.transformOffset(text, entities.map<TextEntity>(e => {
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
            return { from, to, link: TelegramMapper.fixLinkProtocol(link) }
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
            return undefined
        }
        return undefined
      }).filter(Boolean)),
    }
  }

  static mapCallReason(reason: Api.TypePhoneCall | Api.TypePhoneCallDiscardReason) {
    if (reason instanceof Api.PhoneCallAccepted) return 'Accepted'
    if (reason instanceof Api.PhoneCallWaiting) return 'Waiting'
    if (reason instanceof Api.PhoneCallRequested) return 'Requested'
    if (reason instanceof Api.PhoneCallAccepted) return 'Accepted'
    if (reason instanceof Api.PhoneCallDiscardReasonMissed) return 'Missed'
    if (reason instanceof Api.PhoneCallDiscardReasonBusy) return 'Declined'
    if (reason instanceof Api.PhoneCallDiscardReasonDisconnect) return 'Disconnected'
    if (reason instanceof Api.PhoneCallDiscardReasonHangup) return 'Hung up'
    return `Call reason unmapped ${reason}`
  }

  static getButtonLinkURL(row: Api.TypeKeyboardButton, accountID: string, threadID: string, messageID: number) {
    switch (row.className) {
      case 'KeyboardButtonUrl':
      case 'KeyboardButtonUrlAuth':
        return row.url
      case 'KeyboardButtonSwitchInline':
        return 'texts://fill-textarea?text=' + encodeURIComponent(row.query)
      case 'KeyboardButtonCallback':
        return `texts://platform-callback/${accountID}/callback/${threadID}/${messageID}/${'data' in row ? row.data : ''}`
      // case 'inlineKeyboardButtonTypeCallbackGame':
      // case 'inlineKeyboardButtonTypeCallbackWithPassword':
      //   return 'texts://platform-callback/' + row.data
      default:
    }
  }

  static mapUserPresence(userId: bigInt.BigInteger, status: Api.TypeUserStatus): UserPresence {
    const presence: UserPresence = {
      userID: getMarkedId({ userId }),
      lastActive: undefined,
      status: 'offline',
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
    } else if (status instanceof Api.UserStatusOffline) {
      presence.lastActive = new Date(status.wasOnline * 1000)
    }

    return presence
  }

  static mapUserPresenceEvent(userId: bigInt.BigInteger, status: Api.TypeUserStatus): UserPresenceEvent {
    const presence = this.mapUserPresence(userId, status)
    return {
      type: ServerEventType.USER_PRESENCE_UPDATED,
      presence,
    }
  }

  static mapUserAction(update: Api.UpdateUserTyping | Api.UpdateChatUserTyping | Api.UpdateChannelUserTyping): UserActivityEvent {
    const [threadID, participantID] = (() => {
      if (update instanceof Api.UpdateUserTyping) return [update.userId, update.userId] // these don't need to be marked
      if (update instanceof Api.UpdateChatUserTyping) return [getMarkedId({ chatId: update.chatId }), getPeerId(update.fromId)]
      return [getMarkedId({ channelId: update.channelId }), getPeerId(update.fromId)]
    })().map(String)

    const durationMs = 10_000
    const customActivity = (customLabel: string): UserActivityEvent => ({
      type: ServerEventType.USER_ACTIVITY,
      threadID,
      participantID,
      activityType: ActivityType.CUSTOM,
      customLabel,
      durationMs,
    })
    if (update.action instanceof Api.SendMessageTypingAction) {
      return {
        type: ServerEventType.USER_ACTIVITY,
        threadID,
        participantID,
        activityType: ActivityType.TYPING,
        durationMs,
      }
    }
    if (update.action instanceof Api.SendMessageRecordAudioAction) {
      return {
        type: ServerEventType.USER_ACTIVITY,
        threadID,
        participantID,
        activityType: ActivityType.RECORDING_VOICE,
        durationMs,
      }
    }
    if (update.action instanceof Api.SendMessageRecordVideoAction) {
      return {
        type: ServerEventType.USER_ACTIVITY,
        threadID,
        participantID,
        activityType: ActivityType.RECORDING_VIDEO,
        durationMs,
      }
    }
    if (update.action instanceof Api.SendMessageChooseContactAction) { return customActivity('choosing contact') }
    if (update.action instanceof Api.SendMessageGeoLocationAction) { return customActivity('choosing location') }
    if (update.action instanceof Api.SendMessageGamePlayAction) return customActivity('playing a game')
    if (update.action instanceof Api.SendMessageRecordRoundAction) return customActivity('recording a round video')
    if (update.action instanceof Api.SendMessageUploadRoundAction) return customActivity('uploading a round video')
    if (update.action instanceof Api.SendMessageHistoryImportAction) return customActivity('importing chat history')
    if (update.action instanceof Api.SendMessageUploadDocumentAction) return customActivity('uploading a document' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
    if (update.action instanceof Api.SendMessageUploadPhotoAction) return customActivity('uploading a photo' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
    if (update.action instanceof Api.SendMessageUploadVideoAction) return customActivity('uploading a video' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
    if (update.action instanceof Api.SendMessageUploadAudioAction) return customActivity('uploading a voice note' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
    if (update.action instanceof Api.SendMessageChooseStickerAction) return customActivity('choosing a sticker')
    // when the recipient taps on emoji
    if (update.action instanceof Api.SendMessageEmojiInteraction) return customActivity(`watching ${update.action.emoticon} reaction`)
    // when the current user taps on emoji
    if (update.action instanceof Api.SendMessageEmojiInteractionSeen) return customActivity(`watching ${update.action.emoticon} reaction`)
    if (update.action instanceof Api.SendMessageCancelAction) {
      return {
        type: ServerEventType.USER_ACTIVITY,
        threadID,
        participantID,
        activityType: ActivityType.NONE,
      }
    }
    texts.log('unsupported activity', update.action.className, update.action)
  }

  getMessageButtons(replyMarkup: Api.TypeReplyMarkup, threadID: string, messageID: number) {
    if (!replyMarkup) return
    switch (replyMarkup.className) {
      case 'ReplyInlineMarkup':
        return replyMarkup.rows.flatMap<MessageButton>(rows => rows.buttons.map(row => ({
          label: row.text,
          linkURL: TelegramMapper.getButtonLinkURL(row, this.accountID, threadID, messageID) ?? '',
        })))
      case 'ReplyKeyboardMarkup':
        return replyMarkup.rows.flatMap<MessageButton>(rows => rows.buttons.map(row => {
          if (row.className === 'KeyboardButtonSwitchInline') {
            // these appear to be meant to handle automatically if supported by platform
            return {
              label: row.text,
              linkURL: 'texts://fill-textarea?text=' + encodeURIComponent(row.text), // todo: should actually be sent on clicking instantly
            }
          }
          if (row.className.startsWith('KeyboardButton')) {
            return {
              label: row.text,
              linkURL: `texts://platform-callback/${this.accountID}/inline-query/${threadID}/${messageID}/${encodeURIComponent(row.text)}`,
            }
          }
          return { label: `Unsupported link button: ${row.className}`, linkURL: '' }
        })).filter(Boolean)
      default:
    }
  }

  getMediaUrl = (id: bigInt.BigInteger, messageId: number, mimeType: string) =>
    `asset://${this.accountID}/media/${String(id)}/${mime.extension(mimeType) || 'bin'}/${messageId}`

  getProfilePhotoUrl = (assetId: bigInt.BigInteger, userId: bigInt.BigInteger, mimeType = 'image/png') =>
    `asset://${this.accountID}/photos/${String(assetId.xor(userId))}/${mime.extension(mimeType) || 'bin'}/${String(userId)}`

  mapMessageLink(webPage: Api.TypeWebPage, messageId: number) {
    if (!(webPage instanceof Api.WebPage)) return
    const { url, title, description, photo } = webPage
    const link: MessageLink = {
      url,
      title: title ?? '',
      summary: description,
      img: undefined,
      imgSize: undefined,
    }
    if (photo instanceof Api.Photo) {
      link.img = this.getMediaUrl(photo.id, messageId, 'image/png')
      const photoSize = photo.sizes?.find(size => size instanceof Api.PhotoSize)
      link.imgSize = photoSize && 'w' in photoSize ? { width: photoSize.w, height: photoSize.h } : undefined
    }
    return link
  }

  mapTextFooter = (interactionInfo: Api.MessageInteractionCounters) => [...TelegramMapper.getTextFooter(interactionInfo)].join(' · ')

  mapMessageUpdateText(messageID: string, newContent: Api.Message) {
    if ('text' in newContent) {
      return {
        id: messageID,
        text: newContent.text,
        textAttributes: TelegramMapper.mapTextAttributes(newContent.text, newContent.entities ?? []),
        links: newContent.media && 'webpage' in newContent.media && newContent.media.webpage instanceof Api.WebPage
          ? [this.mapMessageLink(newContent.media.webpage, Number(messageID))]
          : undefined,
      }
    }
  }

  mapMessage(msg: CustomMessage, readOutboxMaxId: number): Message {
    const isSender = msg.senderId?.equals(this.me.id)
    const isThreadSender = !isSender && (msg instanceof Api.MessageService || !msg.senderId || msg.senderId.equals(msg.chatId))
    const senderID = isThreadSender ? '$thread' : String(msg.senderId)
    const mapped: Message = {
      _original: stringifyCircular([msg, msg.media?.className, msg.action?.className]),
      id: String(msg.id),
      timestamp: new Date(msg.date * 1000),
      editedTimestamp: msg.editDate && !msg.editHide ? new Date(msg.editDate * 1000) : undefined,
      forwardedCount: msg.forwards || (msg.forward ? 1 : 0),
      senderID,
      isSender,
      linkedMessageID: msg.replyToMsgId?.toString(),
      buttons: msg.replyMarkup && msg.chatId ? this.getMessageButtons(msg.replyMarkup, getMarkedId({ chatId: msg.chatId }), msg.id) : undefined,
      expiresInSeconds: msg.ttlPeriod,
    }
    if (readOutboxMaxId) mapped.seen = msg.id <= readOutboxMaxId

    const setReactions = (reactions: Api.MessageReactions) => {
      if (reactions.recentReactions || reactions.results) {
        const mappedReactions: MessageReaction[] = reactions.recentReactions?.map(r => (
          {
            id: getPeerId(r.peerId),
            participantID: getPeerId(r.peerId),
            emoji: true,
            reactionKey: r.reaction.replace('❤', '❤️'),
          })) ?? []
        const mappedReactionResults: MessageReaction[] = reactions.results?.flatMap(r => {
          const reactionResult = range(r.count).map(c =>
          // we don't really have access to id here
            ({
              id: `${c}${r.reaction}`,
              participantID: `${c}`,
              emoji: true,
              reactionKey: r.reaction.replace('❤', '❤️'),
            }))
          if (r.chosen && reactionResult.length) { reactionResult[reactionResult.length - 1].participantID = String(this.me.id) }
          return reactionResult
        }) ?? []

        mapped.reactions = mappedReactionResults.length ? mappedReactionResults : mappedReactions
      }
    }

    const setFormattedText = (msgText: string, msgEntities: Api.TypeMessageEntity[]) => {
      mapped.text = msgText
      mapped.textAttributes = TelegramMapper.mapTextAttributes(msgText, msgEntities)
    }
    const pushSticker = (sticker: Api.Document, messageId: number) => {
      const isWebm = sticker.mimeType === 'video/webm'
      const isTgs = sticker.mimeType === 'application/x-tgsticker'
      const animated = isTgs || isWebm
      const sizeAttribute = sticker.attributes.find(a => a instanceof Api.DocumentAttributeImageSize || a instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeImageSize | Api.DocumentAttributeVideo
      const size = {
        width: sizeAttribute?.w || 100,
        height: sizeAttribute?.h || 100,
      }
      mapped.attachments ||= []
      mapped.attachments.push({
        id: String(sticker.id),
        srcURL: this.getMediaUrl(sticker.id, messageId, sticker.mimeType),
        mimeType: sticker.mimeType,
        type: isWebm ? MessageAttachmentType.VIDEO : MessageAttachmentType.IMG,
        isGif: true,
        isSticker: true,
        size,
        fileSize: sticker.size?.toJSNumber(),
        extra: {
          loop: animated,
        },
      })
    }

    const mapMessageMedia = () => {
      if (msg.media instanceof Api.MessageMediaPhoto) {
        const { photo } = msg
        if (!photo) return
        const photoSize = photo instanceof Api.Photo ? photo.sizes?.find(size => size instanceof Api.PhotoSize) : undefined
        // setting to 'image/png' seems fine as other formats are sent as "Api.Document"
        mapped.attachments ||= []
        mapped.attachments.push({
          id: String(photo.id),
          srcURL: this.getMediaUrl(photo.id, msg.id, 'image/png'),
          type: MessageAttachmentType.IMG,
          size: photoSize && 'w' in photoSize ? { width: photoSize.w, height: photoSize.h } : undefined,
        })
      } else if (msg.video) {
        if (msg.video.attributes.find(a => a.className === 'DocumentAttributeSticker')) {
          // new animated stickers are webm
          pushSticker(msg.video, msg.id)
        } else {
          mapped.attachments ||= []
          const { video } = msg
          const documentAttribute = video.attributes.find(a => a instanceof Api.DocumentAttributeVideo)
          let size = documentAttribute && 'w' in documentAttribute ? { width: documentAttribute.w, height: documentAttribute.h } : undefined
          if (documentAttribute && 'duration' in documentAttribute && !documentAttribute.duration && size?.height === 1 && size?.width === 1) {
            // Telegram will send videos twice
            // 1st time doesn't have a duration or w/h - presumably this is to "loading" preview
            // need too ignore height
            size = undefined
          }
          mapped.attachments.push({
            id: String(video.id),
            srcURL: this.getMediaUrl(video.id, msg.id, video.mimeType),
            type: MessageAttachmentType.VIDEO,
            fileName: video.accessHash.toString(),
            mimeType: video.mimeType,
            size,
            fileSize: video.size?.toJSNumber(),
          })
        }
      } else if (msg.audio) {
        const { audio } = msg
        mapped.attachments ||= []
        mapped.attachments.push({
          id: String(audio.id),
          srcURL: this.getMediaUrl(audio.id, msg.id, audio.mimeType),
          type: MessageAttachmentType.AUDIO,
          fileName: audio.accessHash.toString(),
          mimeType: audio.mimeType,
          fileSize: audio.size?.toJSNumber(),
        })
      } else if (msg.videoNote) {
        const { videoNote } = msg
        mapped.extra = { ...mapped.extra, className: 'telegram-video-note' }
        mapped.attachments ||= []
        mapped.attachments.push({
          id: String(videoNote.id),
          srcURL: this.getMediaUrl(videoNote.id, msg.id, videoNote.mimeType),
          type: MessageAttachmentType.VIDEO,
          fileSize: videoNote.size?.toJSNumber(),
        })
      } else if (msg.voice) {
        const { voice } = msg
        mapped.attachments ||= []
        mapped.attachments.push({
          id: String(voice.id),
          srcURL: this.getMediaUrl(voice.id, msg.id, voice.mimeType),
          type: MessageAttachmentType.AUDIO,
          fileSize: voice.size?.toJSNumber(),
        })
      } else if (msg.gif) {
        const animation = msg.gif
        const sizeAttribute = animation.attributes.find(a => a instanceof Api.DocumentAttributeImageSize || a instanceof Api.DocumentAttributeVideo)
        mapped.attachments ||= []
        mapped.attachments.push({
          id: String(animation.id),
          srcURL: this.getMediaUrl(animation.id, msg.id, animation.mimeType),
          type: MessageAttachmentType.VIDEO,
          isGif: true,
          fileName: animation.accessHash.toString(),
          fileSize: animation.size.toJSNumber(),
          mimeType: animation.mimeType,
          size: sizeAttribute && 'w' in sizeAttribute ? { height: sizeAttribute.h, width: sizeAttribute.w } : undefined,
        })
      } else if (msg.sticker) {
        pushSticker(msg.sticker, msg.id)
      } else if (msg.contact) {
        const { contact } = msg
        const vcard = contact.vcard ? contact.vcard : new VCard().addName(contact.lastName, contact.firstName).addPhoneNumber(contact.phoneNumber).buildVCard()
        mapped.attachments ||= []
        mapped.attachments.push({
          id: String(contact.userId),
          type: MessageAttachmentType.UNKNOWN,
          data: Buffer.from(vcard, 'utf-8'),
          fileName: ([contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phoneNumber) + '.vcf',
        })
      } else if (msg.document) {
        const { document } = msg
        const sizeAttribute = document.attributes.find(a => a instanceof Api.DocumentAttributeImageSize || Api.DocumentAttributeVideo)
        const fileName = document.attributes.find(f => f instanceof Api.DocumentAttributeFilename)
        mapped.attachments ||= []
        mapped.attachments.push({
          id: String(document.id),
          type: MessageAttachmentType.UNKNOWN,
          srcURL: this.getMediaUrl(document.id, msg.id, document.mimeType),
          fileName: fileName && 'fileName' in fileName ? fileName.fileName : undefined,
          size: sizeAttribute && 'w' in sizeAttribute ? { height: sizeAttribute.h, width: sizeAttribute.w } : undefined,
          mimeType: document.mimeType,
          fileSize: document.size.toJSNumber(),
        })
      } else if (msg.dice) {
        if (mapped.textHeading) mapped.textHeading += '\n'
        else mapped.textHeading = ''
        mapped.extra = { ...mapped.extra, className: 'telegram-dice' }
        mapped.text = msg.dice.emoticon
        mapped.textHeading = `Dice: ${msg.dice.value}`
      } else if (msg.poll) {
        const { poll } = msg
        const pollAnswers = poll.poll.answers.map(a => a.text)
        const isQuiz = poll.poll.quiz
        const mappedResults = poll.results.results ? `${poll.results.results.map((result, index) => [pollAnswers[index], result.chosen
          ? '✔️' : '', `— ${(result.voters / (poll.results.totalVoters ?? result.voters)) * 100}%`, `(${result.voters})`].filter(Boolean).join('\t')).join('\n')}`
          : 'No results available yet'
        mapped.textHeading = `${poll.poll.publicVoters ? 'Anonymous ' : ''}${isQuiz ? 'Quiz' : 'Poll'}\n\n\n` + mappedResults
      } else if (msg.media instanceof Api.MessageMediaWebPage) {
        const msgMediaLink = this.mapMessageLink(msg.media.webpage, msg.id)
        mapped.links = msgMediaLink ? [msgMediaLink] : undefined
      } else {
        mapped.textHeading = `Unsupported Telegram media ${msg.media?.className}`
      }
    }

    const mapMessageService = () => {
      const sender = mapped.senderID === '$thread' && msg.fromId && 'userId' in msg.fromId ? `{{${msg.fromId.userId}}}` : '{{sender}}'
      if (msg.action instanceof Api.MessageActionPhoneCall) {
        const isShortDuration = Number(msg.action.duration) < 3600
        const startIndexDuration = isShortDuration ? 11 + 4 : 11
        const endIndexDuration = isShortDuration ? startIndexDuration + 4 : startIndexDuration + 8
        mapped.textHeading = [
          `${msg.action.video ? '🎥 Video ' : '📞 '}Call`,
          msg.action.duration ? new Date(msg.action.duration * 1000)
            .toISOString()
            .substring(startIndexDuration, endIndexDuration) : '',
          msg.action.reason ? TelegramMapper.mapCallReason(msg.action.reason) : '',
        ].filter(Boolean).join('\n')
      } else if (msg.action instanceof Api.MessageActionPinMessage) {
        mapped.text = `${sender} pinned a message`
        mapped.isAction = true
        mapped.parseTemplate = true
      } else if (msg.action instanceof Api.MessageActionContactSignUp) {
        mapped.text = `${sender} joined Telegram`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.behavior = MessageBehavior.SILENT
      } else if (msg.action instanceof Api.MessageActionChatEditTitle) {
        mapped.text = `${sender} changed the thread title to "${msg.action.title}"`
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
          actorParticipantID: '',
        }
      } else if (msg.action instanceof Api.MessageActionChatDeleteUser) {
        mapped.text = `{{${msg.action.userId}}} left the group`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.THREAD_PARTICIPANTS_REMOVED,
          participantIDs: [String(msg.action.userId)],
          actorParticipantID: '',
        }
      } else if (msg.action instanceof Api.MessageActionChatJoinedByLink) {
        mapped.text = `${sender} joined the group via invite link`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.THREAD_PARTICIPANTS_ADDED,
          participantIDs: [sender],
          actorParticipantID: '',
        }
      } else if (msg.action instanceof Api.MessageActionChatJoinedByRequest) {
        mapped.text = `${sender} was accepted into the group`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.THREAD_PARTICIPANTS_ADDED,
          participantIDs: [sender],
          actorParticipantID: '',
        }
      } else if (msg.action instanceof Api.MessageActionChatEditPhoto) {
        mapped.text = `${sender} updated the group photo`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.THREAD_IMG_CHANGED,
          actorParticipantID: '',
        }
      } else if (msg.action instanceof Api.MessageActionChatDeletePhoto) {
        mapped.text = `${sender}} deleted the group photo`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.THREAD_IMG_CHANGED,
          actorParticipantID: mapped.senderID,
        }
      } else if (msg.action instanceof Api.MessageActionChatCreate) {
        const title = msg.chat && 'title' in msg.chat ? msg.chat.title : ''
        mapped.text = `${sender} created the group "${title}"`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.GROUP_THREAD_CREATED,
          actorParticipantID: mapped.senderID,
          title,
        }
      } else if (msg.action instanceof Api.MessageActionChannelCreate) {
        const title = msg.chat && 'title' in msg.chat ? msg.chat.title : ''
        mapped.text = `Channel "${title}" was created`
        mapped.isAction = true
        mapped.action = {
          type: MessageActionType.GROUP_THREAD_CREATED,
          actorParticipantID: mapped.senderID,
          title,
        }
      } else if (msg.action instanceof Api.MessageActionChannelMigrateFrom) {
        const title = msg.chat && 'title' in msg.chat ? msg.chat.title : ''
        mapped.text = `Group "${title}" was created`
        mapped.isAction = true
      } else if (msg.action instanceof Api.MessageActionChatMigrateTo) {
        const title = msg.chat && 'title' in msg.chat ? msg.chat.title : ''
        mapped.text = `Group "${title}" was migrated`
        mapped.isAction = true
      } else if (msg.action instanceof Api.MessageActionCustomAction) {
        mapped.text = msg.text
        mapped.isAction = true
        mapped.parseTemplate = true
      } else if (msg.action instanceof Api.MessageActionPaymentSent) {
        mapped.text = `You have successfully transfered ${msg.action.currency} ${msg.action.totalAmount}`
        mapped.isAction = true
        mapped.parseTemplate = true
      } else if (msg.action instanceof Api.MessageActionSetChatTheme) {
        mapped.text = msg.action.emoticon
          ? `${sender} changed the chat theme to ${msg.action.emoticon}`
          : `${sender} disabled the chat theme`
        mapped.isAction = true
        mapped.parseTemplate = true
      } else if (msg.action instanceof Api.MessageActionSetMessagesTTL) {
        const days = Math.floor(msg.action.period / (60 * 60 * 24))
        mapped.text = msg.action.period
          ? `${sender} set messages to automatically delete after ${days} day${days === 1 ? '' : 's'}`
          : `${sender} disabled the auto-delete timer`
        mapped.isAction = true
        mapped.parseTemplate = true
      } else if (msg.action instanceof Api.MessageActionHistoryClear) {
        return undefined
      }
      return true
    }

    if (msg.text) {
      setFormattedText(msg.rawText, msg.entities ?? [])
      if (msg.webPreview) {
        const msgLink = this.mapMessageLink(msg.webPreview, msg.id)
        mapped.links = msgLink ? [msgLink] : undefined
      }
    } else if (msg.message) {
      mapped.text = msg.message
    }
    if (msg.reactions) {
      setReactions(msg.reactions)
    }
    if (msg.media) {
      mapMessageMedia()
    }

    if (msg instanceof Api.MessageService) {
      if (!mapMessageService()) return undefined
    }

    if (msg.geo instanceof Api.GeoPoint) {
      const location = msg.geo
      if (mapped.textHeading) mapped.textHeading += '\n'
      else mapped.textHeading = ''
      mapped.textHeading += '📍 Location'
      mapped.text = `https://www.google.com/maps?q=${location.lat},${location.long}`
    }
    if (msg.venue) {
      const { venue } = msg
      mapped.textHeading = '📍 Venue'
      mapped.text = [
        venue.title,
        venue.address,
        venue.geo instanceof Api.GeoPoint ? `https://www.google.com/maps?q=${venue.geo.lat},${venue.geo.long}` : '',
      ].join('\n')
    }
    return mapped
  }

  mapUser = (user: Api.User): User => {
    const mapped: User = {
      id: String(user.id),
      username: user.username,
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    }
    if (user.photo instanceof Api.UserProfilePhoto) mapped.imgURL = this.getProfilePhotoUrl(user.photo.photoId, user.id)
    if (user.phone) mapped.phoneNumber = '+' + user.phone
    if (user.verified) mapped.isVerified = true
    if (user.id === this.me.id) mapped.isSelf = true
    return mapped
  }

  mapParticipant = (user: Api.User, adminIds?: Set<number>): Participant => {
    const participant: Participant = this.mapUser(user)
    let isAdmin = false
    if (adminIds?.has(user?.id?.toJSNumber())) {
      isAdmin = true
    }
    return {
      ...participant,
      isAdmin,
    }
  }

  mapMuteUntil = (seconds: number) => {
    if (seconds >= MUTED_FOREVER_CONSTANT) return 'forever'
    if (seconds === 0) return
    return addSeconds(new Date(), seconds)
  }

  private hasWritePermissions = (entity: Entity) => {
    // signle and group chats (entity instanceof Api.User || entity instanceof Api.Chat) can always be written to
    if (entity instanceof Api.Channel && (!entity.adminRights && !entity.bannedRights && !entity.defaultBannedRights)) return false
    return true
  }

  mapThread = (dialog: Dialog, participants: Participant[]): Thread => {
    if (!dialog.id) throw new Error(`Dialog had no id ${stringifyCircular(dialog.inputEntity, 2)}`)
    const isSingle = dialog.dialog.peer instanceof Api.PeerUser
    const isChannel = dialog.dialog.peer instanceof Api.PeerChannel
    const photo = dialog.entity && 'photo' in dialog.entity ? dialog.entity.photo : undefined
    const imgURL = photo instanceof Api.ChatPhoto ? this.getProfilePhotoUrl(photo.photoId, dialog.id) : undefined
    const isReadOnly = !this.hasWritePermissions(dialog.entity)

    const t: Thread = {
      _original: stringifyCircular(dialog.dialog),
      id: getPeerId(dialog.id),
      type: isSingle ? 'single' : isChannel ? 'channel' : 'group',
      // isPinned: dialog.pinned,
      isArchived: dialog.archived,
      timestamp: new Date(dialog.date * 1000),
      isUnread: dialog.unreadCount !== 0,
      isReadOnly,
      lastReadMessageID: String(dialog.message?.out ? dialog.dialog.readOutboxMaxId : dialog.dialog.readInboxMaxId),
      mutedUntil: this.mapMuteUntil(dialog.dialog.notifySettings.muteUntil ?? 0),
      imgURL,
      title: dialog.title,
      participants: {
        hasMore: false,
        items: participants,
      },
      messages: {
        hasMore: true,
        items: dialog.message ? [this.mapMessage(dialog.message, dialog.dialog.readOutboxMaxId)].filter(Boolean) : [],
      },
    }
    return t
  }

  mapMessages = (messages: Api.Message[], readOutboxMaxId: number) =>
    messages
      .sort((a, b) => a.date - b.date)
      .map(m => this.mapMessage(m, readOutboxMaxId))
      .filter(Boolean)

  mapUpdate = (update: Api.TypeUpdate | Api.TypeUpdates): ServerEvent[] => {
    texts.log(update.className)
    if (update instanceof Api.UpdateNotifySettings) {
      if (!('peer' in update.peer)) {
        texts.log('Unknown updateNotifySettings', stringifyCircular(update, 2))
        return []
      }
      const mutedForever = update.notifySettings.silent ? 'forever' : 0
      return [{
        type: ServerEventType.STATE_SYNC,
        objectIDs: {},
        mutationType: 'update',
        objectName: 'thread',
        entries: [{
          id: getPeerId(update.peer.peer),
          mutedUntil: mutedForever || this.mapMuteUntil(update.notifySettings.muteUntil),
        }],
      }]
    }
    if (update instanceof Api.UpdateFolderPeers) {
      return update.folderPeers.map<ServerEvent>(f => ({
        type: ServerEventType.STATE_SYNC,
        objectIDs: {},
        mutationType: 'update',
        objectName: 'thread',
        entries: [{
          id: getPeerId(f.peer),
          isArchived: f.folderId === 1,
        }],
      }))
    }
    if (update instanceof Api.UpdateDialogUnreadMark) {
      if (!(update.peer instanceof Api.DialogPeer)) return []
      const threadID = getPeerId(update.peer.peer)
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'thread',
        objectIDs: {},
        entries: [
          {
            id: threadID,
            isUnread: update.unread,
          },
        ],
      }]
    }
    if (update instanceof Api.UpdateReadHistoryInbox || update instanceof Api.UpdateReadChannelInbox) {
      const threadID = 'peer' in update ? getPeerId(update.peer) : getMarkedId({ channelId: update.channelId })
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'thread',
        objectIDs: {},
        entries: [
          {
            id: threadID,
            isUnread: update.stillUnreadCount > 0,
          },
        ],
      }]
    }
    if (update instanceof Api.UpdateReadHistoryOutbox || update instanceof Api.UpdateReadChannelOutbox) {
      const threadID = 'peer' in update ? getPeerId(update.peer) : getMarkedId({ channelId: update.channelId })
      const messageID = String(update.maxId)
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'message',
        objectIDs: { threadID },
        entries: [{
          id: messageID,
          seen: true,
        }],
      }]
    }
    if (update instanceof Api.UpdateUserTyping || update instanceof Api.UpdateChatUserTyping || update instanceof Api.UpdateChannelUserTyping) {
      return [TelegramMapper.mapUserAction(update)]
    }
    if (update instanceof Api.UpdateUserStatus) {
      return [TelegramMapper.mapUserPresenceEvent(update.userId, update.status)]
    }
    if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
      if (update.message instanceof Api.MessageEmpty) return []
      const threadID = update.message.chatId.toString() // deliberately unmarked
      const updatedMessage = this.mapMessage(update.message, undefined)
      if (!updatedMessage) return
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'message',
        objectIDs: { threadID },
        entries: [updatedMessage],
      }]
    }
    if (update instanceof Api.UpdateShortMessage || update instanceof Api.UpdateShortChatMessage) {
      const threadID = getUnmarkedId(update)
      // TODO: review if all props are present
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'message',
        objectIDs: { threadID },
        entries: [{
          id: String(update.id),
          text: update.message,
        }],
      }]
    }
    if (update instanceof Api.UpdatePeerHistoryTTL) {
      const threadID = getPeerId(update.peer)
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'thread',
        objectIDs: {},
        entries: [
          {
            id: threadID,
            messageExpirySeconds: update.ttlPeriod,
          },
        ],
      }]
    }
    if (update instanceof Api.UpdateUserPhoto) {
      if (!(update.photo instanceof Api.UserProfilePhoto)) return []
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'participant',
        objectIDs: { threadID: String(update.userId) },
        entries: [
          {
            id: String(update.userId),
            imgURL: this.getProfilePhotoUrl(update.photo.photoId, update.userId),
          },
        ],
      }]
    }
    texts.log('Unmapped update', update.className/* , stringifyCircular(update) */)

    return []
  }
}
