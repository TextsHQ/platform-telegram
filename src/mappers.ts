import { Message, Thread, User, MessageAttachmentType, TextAttributes, TextEntity, MessageButton, MessageLink, UserPresenceEvent, ServerEventType, UserPresence, ActivityType, UserActivityEvent, MessageActionType, MessageReaction, AccountInfo, Size, Participant, ServerEvent, texts } from '@textshq/platform-sdk'
import { addSeconds } from 'date-fns'
import { range } from 'lodash'
import VCard from 'vcard-creator'
import { getPeerId } from 'telegram/Utils'
import { Api } from 'telegram/tl'

import type bigInt from 'big-integer'
import type { CustomMessage } from 'telegram/tl/custom/message'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { Entity } from 'telegram/define'

import { MUTED_FOREVER_CONSTANT } from './constants'
import { stringifyCircular } from './util'

type MapperData = { accountID: string, me: Api.User }
export default class TelegramMapper {
  private mapperData: MapperData

  constructor(accountInfo: AccountInfo, me: Api.User) {
    this.mapperData = {
      accountID: accountInfo.accountID,
      me,
    }
  }

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

  static getButtonLinkURL(row: Api.TypeKeyboardButton, accountID: string, chatID: bigInt.BigInteger, messageID: number) {
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

  static mapUserPresence(userId: bigInt.BigInteger, status: Api.TypeUserStatus): UserPresenceEvent {
    const presence: UserPresence = {
      userID: userId.toString(),
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
    }
    return {
      type: ServerEventType.USER_PRESENCE_UPDATED,
      presence,
    }
  }

  static mapUserAction(update: Api.UpdateUserTyping | Api.UpdateChatUserTyping | Api.UpdateChannelUserTyping): UserActivityEvent {
    const [threadID, participantID] = (() => {
      if (update instanceof Api.UpdateUserTyping) return [update.userId, update.userId]
      if (update instanceof Api.UpdateChatUserTyping) return [update.chatId, update.fromId]
      return [update.channelId, update.fromId]
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
    if (update.action instanceof Api.SendMessageUploadDocumentAction) return customActivity('uploading a document' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
    if (update.action instanceof Api.SendMessageUploadPhotoAction) return customActivity('uploading a photo' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
    if (update.action instanceof Api.SendMessageUploadVideoAction) return customActivity('uploading a video' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
    if (update.action instanceof Api.SendMessageUploadAudioAction) return customActivity('uploading a voice note' + (update.action.progress ? ` (${update.action.progress}%)` : ''))
    if (update.action instanceof Api.SendMessageChooseStickerAction) return customActivity('choosing a sticker')
    if (update.action instanceof Api.SendMessageCancelAction) {
      return {
        type: ServerEventType.USER_ACTIVITY,
        threadID,
        participantID,
        activityType: ActivityType.NONE,
      }
    }
    return customActivity(`(unsupported activity ${update.action.className} ${JSON.stringify(update.action)})`)
  }

  getMessageButtons(replyMarkup: Api.TypeReplyMarkup, chatID: bigInt.BigInteger, messageID: number) {
    if (!replyMarkup) return
    switch (replyMarkup.className) {
      case 'ReplyInlineMarkup':
        return replyMarkup.rows.flatMap<MessageButton>(rows => rows.buttons.map(row => ({
          label: row.text,
          linkURL: TelegramMapper.getButtonLinkURL(row, this.mapperData.accountID, chatID, messageID) ?? '',
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
              linkURL: 'texts://fill-textarea?text=' + encodeURIComponent(row.text),
            }
          }
          return { label: `Unsupported link button: ${row.className}`, linkURL: '' }
        })).filter(Boolean)
      default:
    }
  }

  getMediaUrl = (id: bigInt.BigInteger, messageId: number) => `asset://${this.mapperData.accountID}/media/${id}/${messageId}`

  getStickerUrl = (id: bigInt.BigInteger, messageId: number) => `asset://${this.mapperData.accountID}/media/${id}/${messageId}/sticker`

  getProfilePhotoUrl = (id: bigInt.BigInteger) => `asset://${this.mapperData.accountID}/photos/${id}`

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
    if (photo instanceof Api.Photo) link.img = this.getMediaUrl(photo.id, messageId)
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

  mapMessage(msg: CustomMessage): Message {
    const isThreadMessage = msg instanceof Api.MessageService
    const senderID = isThreadMessage ? '$thread' : msg.senderId?.toString() ?? this.mapperData.me.id.toString()
    const mapped: Message = {
      _original: stringifyCircular(msg),
      id: msg.id.toString(),
      timestamp: new Date(msg.date * 1000),
      editedTimestamp: msg.editDate && !msg.reactions?.recentReactions?.length ? new Date(msg.editDate * 1000) : undefined,
      forwardedCount: msg.forwards,
      senderID,
      isSender: msg.out && !isThreadMessage,
      linkedMessageID: msg.replyToMsgId?.toString(),
      buttons: msg.replyMarkup && msg.chatId ? this.getMessageButtons(msg.replyMarkup, msg.chatId, msg.id) : undefined,
      expiresInSeconds: msg.ttlPeriod,
    }

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
          if (r.chosen && reactionResult.length) { reactionResult[reactionResult.length - 1].participantID = this.mapperData.me.id.toString() }
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
      const animated = sticker.mimeType === 'application/x-tgsticker' || isWebm
      const mimeType = sticker.mimeType === 'application/x-tgsticker' ? 'image/tgs' : isWebm ? 'video/webm' : undefined
      const sizeAttribute = sticker.attributes.find(a => a instanceof Api.DocumentAttributeImageSize || a instanceof Api.DocumentAttributeVideo)
      let size: Size | undefined
      if (sizeAttribute && 'w' in sizeAttribute) {
        size = {
          width: sizeAttribute.w,
          height: sizeAttribute.h,
        }
        size.height = sizeAttribute.h
        mapped.attachments = mapped.attachments || []
        mapped.attachments.push({
          id: sticker.id.toString(),
          srcURL: this.getStickerUrl(sticker.id, messageId),
          mimeType,
          type: isWebm ? MessageAttachmentType.VIDEO : MessageAttachmentType.IMG,
          isGif: true,
          isSticker: true,
          size,
          extra: {
            loop: animated,
          },
        })
      }
    }

    const mapMessageMedia = () => {
      if (msg.media instanceof Api.MessageMediaPhoto) {
        const { photo } = msg
        if (!photo) return
        mapped.attachments = mapped.attachments || []
        const photoSize = photo instanceof Api.Photo ? photo.sizes?.find(size => size instanceof Api.PhotoSize) : undefined
        mapped.attachments.push({
          id: String(photo.id),
          srcURL: this.getMediaUrl(photo.id, msg.id),
          type: MessageAttachmentType.IMG,
          size: photoSize && 'w' in photoSize ? { width: photoSize.w, height: photoSize.h } : undefined,
        })
      } else if (msg.video) {
        if (msg.video.attributes.find(a => a.className === 'DocumentAttributeSticker')) {
          // new animated stickers are webm
          pushSticker(msg.video, msg.id)
        } else {
          const { video } = msg
          const sizeAttribute = video.attributes.find(a => a instanceof Api.DocumentAttributeVideo)
          mapped.attachments = mapped.attachments || []
          mapped.attachments.push({
            id: String(video.id),
            srcURL: this.getMediaUrl(video.id, msg.id),
            type: MessageAttachmentType.VIDEO,
            fileName: video.accessHash.toString(),
            mimeType: video.mimeType,
            size: sizeAttribute && 'w' in sizeAttribute ? { width: sizeAttribute.w, height: sizeAttribute.h } : undefined,
          })
        }
      } else if (msg.audio) {
        const { audio } = msg
        mapped.attachments = mapped.attachments || []
        mapped.attachments.push({
          id: String(audio.id),
          srcURL: this.getMediaUrl(audio.id, msg.id),
          type: MessageAttachmentType.AUDIO,
          fileName: audio.accessHash.toString(),
          mimeType: audio.mimeType,
        })
      } else if (msg.videoNote) {
        const { videoNote } = msg
        mapped.extra = { ...mapped.extra, className: 'telegram-video-note' }
        mapped.attachments = mapped.attachments || []
        mapped.attachments.push({
          id: String(videoNote.id),
          srcURL: this.getMediaUrl(videoNote.id, msg.id),
          type: MessageAttachmentType.VIDEO,
        })
      } else if (msg.voice) {
        const { voice } = msg
        mapped.attachments = mapped.attachments || []
        mapped.attachments.push({
          id: String(voice.id),
          srcURL: this.getMediaUrl(voice.id, msg.id),
          type: MessageAttachmentType.AUDIO,
        })
      } else if (msg.gif) {
        const animation = msg.gif
        mapped.attachments = mapped.attachments || []
        const sizeAttribute = animation.attributes.find(a => a instanceof Api.DocumentAttributeImageSize || a instanceof Api.DocumentAttributeVideo)
        mapped.attachments.push({
          id: String(animation.id),
          srcURL: this.getMediaUrl(animation.id, msg.id),
          type: MessageAttachmentType.VIDEO,
          isGif: true,
          fileName: animation.accessHash.toString(),
          mimeType: animation.mimeType,
          size: sizeAttribute && 'w' in sizeAttribute ? { height: sizeAttribute.h, width: sizeAttribute.w } : undefined,
        })
      } else if (msg.sticker) {
        pushSticker(msg.sticker, msg.id)
      } else if (msg.contact) {
        const { contact } = msg
        const vcard = contact.vcard ? contact.vcard : new VCard().addName(contact.lastName, contact.firstName).addPhoneNumber(contact.phoneNumber).buildVCard()
        mapped.attachments = mapped.attachments || []
        mapped.attachments.push({
          id: String(contact.userId),
          type: MessageAttachmentType.UNKNOWN,
          data: Buffer.from(vcard, 'utf-8'),
          fileName: ([contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phoneNumber) + '.vcf',
        })
      } else if (msg.document) {
        const { document } = msg
        const sizeAttribute = document.attributes.find(a => a instanceof Api.DocumentAttributeImageSize || Api.DocumentAttributeVideo)
        mapped.attachments = mapped.attachments || []
        const fileName = document.attributes.find(f => f instanceof Api.DocumentAttributeFilename)
        mapped.attachments.push({
          id: String(document.id),
          type: MessageAttachmentType.UNKNOWN,
          srcURL: this.getMediaUrl(document.id, msg.id),
          fileName: fileName && 'fileName' in fileName ? fileName.fileName : undefined,
          size: sizeAttribute && 'w' in sizeAttribute ? { height: sizeAttribute.h, width: sizeAttribute.w } : undefined,
          mimeType: document.mimeType,
          fileSize: document.size,
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
        mapped.text = `${sender} left the group`
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
      } else if (msg.action instanceof Api.MessageActionChatCreate || msg.action instanceof Api.MessageActionChannelCreate) {
        const title = msg.chat && 'title' in msg.chat ? msg.chat.title : ''
        mapped.text = `${sender} created the group "${title}"`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.GROUP_THREAD_CREATED,
          actorParticipantID: mapped.senderID,
          title,
        }
      } else if (msg.action instanceof Api.MessageActionChatMigrateTo) {
        const title = msg.chat && 'title' in msg.chat ? msg.chat.title : ''
        mapped.text = `${sender} migrated the group "${title}"`
        mapped.isAction = true
        mapped.parseTemplate = true
      } else if (msg.action instanceof Api.MessageActionCustomAction) {
        mapped.text = msg.text
        mapped.isAction = true
        mapped.parseTemplate = true
      } else if (msg.action instanceof Api.MessageActionPaymentSent) {
        mapped.text = `You have successfully transfered ${msg.action.currency} ${msg.action.totalAmount}`
        mapped.isAction = true
        mapped.parseTemplate = true
      } else if (msg.action instanceof Api.MessageActionHistoryClear) {
        return undefined
      } else {
        mapped.textHeading = `Unsupported Telegram message ${msg.media?.className} ${msg.action?.className}`
      }
      return true
    }

    if (msg.text) {
      setFormattedText(msg.rawText, msg.entities ?? [])
      if (msg.webPreview) {
        const msgLink = this.mapMessageLink(msg.webPreview, msg.id)
        mapped.links = msgLink ? [msgLink] : undefined
      }
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
      id: user.id.toString(),
      username: user.username,
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    }
    if (user.photo instanceof Api.UserProfilePhoto) mapped.imgURL = this.getProfilePhotoUrl(user.id)
    if (user.phone) mapped.phoneNumber = '+' + user.phone
    if (user.verified) mapped.isVerified = true
    if (user.id === this.mapperData.me.id) mapped.isSelf = true
    return mapped
  }

  mapMuteUntil = (seconds: number) => {
    if (seconds >= MUTED_FOREVER_CONSTANT) return 'forever'
    if (seconds === 0) return
    return addSeconds(new Date(), seconds)
  }

  private hasWritePermissions = (entity: Entity) => {
    const channelWrite = ('adminRights' in entity && entity.adminRights?.postMessages)
    && ('bannedRights' in entity && !entity.bannedRights?.sendMessages)
    && ('defaultBannedRights' in entity && !entity.defaultBannedRights?.sendMessages)
    const userWrite = entity instanceof Api.User || entity instanceof Api.Chat
    return channelWrite || userWrite
  }

  mapThread = (dialog: Dialog, participants: Participant[]): Thread => {
    if (!dialog.id) throw new Error(`Dialog had no id ${stringifyCircular(dialog.inputEntity, 2)}`)
    const isSingle = dialog.dialog.peer instanceof Api.PeerUser
    const isChannel = dialog.dialog.peer instanceof Api.PeerChannel
    const photo = dialog.entity && 'photo' in dialog.entity ? dialog.entity.photo : undefined
    const hasPhoto = photo instanceof Api.UserProfilePhoto || photo instanceof Api.ChatPhoto
    const imgFile = isSingle || !hasPhoto ? undefined : this.getProfilePhotoUrl(dialog.id)
    const isReadOnly = !this.hasWritePermissions(dialog.entity)
    const t: Thread = {
      _original: stringifyCircular(dialog.dialog),
      id: String(getPeerId(dialog.id)),
      type: isSingle ? 'single' : isChannel ? 'channel' : 'group',
      isPinned: dialog.pinned,
      isArchived: dialog.archived,
      timestamp: new Date(dialog.date * 1000),
      isUnread: dialog.unreadCount !== 0,
      isReadOnly,
      lastReadMessageID: (dialog.message?.out ? dialog.dialog.readOutboxMaxId : dialog.dialog.readInboxMaxId).toString(),
      mutedUntil: this.mapMuteUntil(dialog.dialog.notifySettings.muteUntil ?? 0),
      imgURL: imgFile,
      title: dialog.title,
      participants: {
        hasMore: false,
        items: participants,
      },
      messages: {
        hasMore: true,
        items: dialog.message ? [this.mapMessage(dialog.message)].filter(Boolean) : [],
      },
    }
    return t
  }

  mapMessages = (messages: Api.Message[]) => messages.sort((a, b) => a.date - b.date).map(m => this.mapMessage(m)).filter(Boolean)

  mapUpdate = (update: Api.TypeUpdate): ServerEvent[] => {
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
          id: getPeerId(update.peer.peer).toString(),
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
          id: getPeerId(f.peer).toString(),
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
    if (update instanceof Api.UpdateReadHistoryInbox) {
      const threadID = getPeerId(update.peer)
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
    if (update instanceof Api.UpdateReadHistoryOutbox) {
      const threadID = getPeerId(update.peer)
      const messageID = update.maxId.toString()
      return [{
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
      }]
    }
    if (update instanceof Api.UpdateUserTyping || update instanceof Api.UpdateChatUserTyping || update instanceof Api.UpdateChannelUserTyping) {
      return [TelegramMapper.mapUserAction(update)]
    }
    if (update instanceof Api.UpdateUserStatus) {
      return [TelegramMapper.mapUserPresence(update.userId, update.status)]
    }
    if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
      if (update.message instanceof Api.MessageEmpty) return []
      const threadID = getPeerId(update.message.peerId).toString()
      const updatedMessage = this.mapMessage(update.message)
      if (!updatedMessage) return
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'message',
        objectIDs: { threadID, messageID: update.message.id.toString() },
        entries: [updatedMessage],
      }]
    }
    if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
      // already handled
    } else {
      texts.log('Unmapped update', update.className, stringifyCircular(update))
    }
    return []
  }
}
