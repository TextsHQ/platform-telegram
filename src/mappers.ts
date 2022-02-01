import { Message, Thread, User, MessageAttachmentType, TextAttributes, TextEntity, MessageButton, MessageLink, UserPresenceEvent, ServerEventType, UserPresence, ActivityType, UserActivityEvent, MessageActionType, MessageReaction, AccountInfo, texts } from '@textshq/platform-sdk'
import { addSeconds } from 'date-fns'
import { Api } from 'telegram/tl'
import type { CustomMessage } from 'telegram/tl/custom/message'
import { getPeerId } from 'telegram/Utils'
import type bigInt from 'big-integer'
import type { Dialog } from 'telegram/tl/custom/dialog'
import url from 'url'
import path from 'path'
import fs from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { MUTED_FOREVER_CONSTANT } from './constants'
import { fileExists, stringifyCircular } from './util'

type MapperData = { accountID: string, assetsDir: string, mediaDir: string, photosDir: string }
export default class TelegramMapper {
  private mapperData: MapperData

  constructor(accountInfo: AccountInfo) {
    this.mapperData = {
      accountID: accountInfo.accountID,
      assetsDir: accountInfo.dataDirPath,
      mediaDir: path.join(accountInfo.dataDirPath, 'media'),
      photosDir: path.join(accountInfo.dataDirPath, 'photos'),
    }
    if (!existsSync(this.mapperData.assetsDir)) mkdirSync(this.mapperData.assetsDir)
    if (!existsSync(this.mapperData.mediaDir)) mkdirSync(this.mapperData.mediaDir)
    if (!existsSync(this.mapperData.photosDir)) mkdirSync(this.mapperData.photosDir)
  }

  saveAsset = async (buffer: Buffer, assetType: 'media' | 'photos', filename: string) => {
    const filePath = path.join(this.mapperData.assetsDir, assetType, filename)
    await fs.writeFile(filePath, buffer)
    return filePath
  }

  getAssetPath = async (assetType: 'media' | 'photos', id: string | number) => {
    const filePath = path.join(this.mapperData.assetsDir, assetType, id.toString())
    return await fileExists(filePath) ? url.pathToFileURL(filePath).href : undefined
  }

  deleteAssetsDir = async () => {
    await fs.rm(this.mapperData.assetsDir, { recursive: true })
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

  static mapTextAttributes(text: string, entities: Api.TypeMessageEntity[]): TextAttributes {
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
            return { from, to }
        }
        return undefined
      }).filter(Boolean)),
    }
  }

  static mapCallReason(discardReason: Api.TypePhoneCallDiscardReason) {
    if (discardReason instanceof Api.PhoneCallDiscardReasonMissed) return 'Missed'
    if (discardReason instanceof Api.PhoneCallDiscardReasonBusy) return 'Declined'
    if (discardReason instanceof Api.PhoneCallDiscardReasonDisconnect) return 'Disconnected'
    if (discardReason instanceof Api.PhoneCallDiscardReasonHangup) return 'Hung up'
    return ''
  }

  static getButtonLinkURL(row: Api.TypeKeyboardButton, accountID: string, chatID: number, messageID: number) {
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

  static mapUserPresence(userId: number, status: Api.TypeUserStatus): UserPresenceEvent {
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

  static mapUserAction(update: Api.UpdateUserTyping): UserActivityEvent {
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

  static idFromPeer(peer: Api.TypePeer): number {
    if (peer instanceof Api.PeerChat) { return peer.chatId.toJSNumber() }
    if (peer instanceof Api.PeerChannel) { return peer.channelId.toJSNumber() }
    return peer.userId.toJSNumber()
  }

  getMessageButtons(replyMarkup: Api.TypeReplyMarkup, chatID: number, messageID: number) {
    if (!replyMarkup) return
    switch (replyMarkup.className) {
      case 'ReplyInlineMarkup':
        return replyMarkup.rows.flatMap<MessageButton>(rows => rows.buttons.map(row => ({
          label: row.text,
          linkURL: TelegramMapper.getButtonLinkURL(row, this.mapperData.accountID, chatID, messageID),
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

  getMediaUrl = async (id: bigInt.BigInteger, messageId: number) => `asset://${this.mapperData.accountID}/media/${id}/${messageId}`

  getProfilePhotoUrl = async (id: bigInt.BigInteger) => `asset://${this.mapperData.accountID}/photos/${id}`

  async mapLinkImg(photo: Api.Photo, messageId: number): Promise<Partial<MessageLink>> {
    if (photo.sizes.length < 1) return
    const photoSize = photo.sizes.find(size => size instanceof Api.PhotoSize)
    if (photoSize instanceof Api.PhotoSize) {
      const { w, h } = photoSize
      const imgSize = { width: w, height: h }
      const file = photo

      const img = await this.getMediaUrl(file.id, messageId)
      return { img, imgSize }
    }
  }

  mapMessageLink(webPage: Api.TypeWebPage, messageId: number) {
    if (!(webPage instanceof Api.WebPage)) return
    const { url: originalURL, displayUrl, title, description, photo } = webPage
    const link: MessageLink = {
      url: displayUrl,
      originalURL,
      title,
      summary: description,
      img: undefined,
      imgSize: undefined,
    }
    if (photo instanceof Api.Photo) Object.assign(link, this.mapLinkImg(photo, messageId))
    return link
  }

  mapTextFooter = (interactionInfo: Api.MessageInteractionCounters) => [...TelegramMapper.getTextFooter(interactionInfo)].join(' · ')

  getSenderID = (msg: CustomMessage) => msg.senderId

  mapMessageUpdateText(messageID: string, newContent: Api.Message) {
    if ('text' in newContent) {
      return {
        id: messageID,
        text: newContent.text,
        textAttributes: TelegramMapper.mapTextAttributes(newContent.text, newContent.entities),
        links: 'webpage' in newContent.media && newContent.media.webpage instanceof Api.WebPage
          ? [this.mapMessageLink(newContent.media.webpage, Number(messageID))]
          : undefined,
      }
    }
  }

  async mapMessage(msg: CustomMessage) {
    const mapped: Message = {
      _original: stringifyCircular(msg),
      id: String(msg.id),
      timestamp: new Date(msg.date * 1000),
      editedTimestamp: msg.editDate && !msg.reactions?.recentReactons?.length ? new Date(msg.editDate * 1000) : undefined,
      forwardedCount: msg.forwards,
      senderID: String(this.getSenderID(msg)),
      isSender: msg.out,
      linkedMessageID: msg.replyTo ? String(msg.replyToMsgId) : undefined,
      buttons: this.getMessageButtons(msg.replyMarkup, msg.chatId.toJSNumber(), msg.id),
      expiresInSeconds: msg.ttlPeriod,
    }

    const setReactions = (reactions: Api.MessageReactions) => {
      if (reactions && reactions.recentReactons) {
        const mappedReactions: MessageReaction[] = reactions.recentReactons.map(r => (
          {
            id: r.userId.toString(),
            participantID: r.userId.toString(),
            emoji: true,
            reactionKey: r.reaction.replace('❤', '❤️'),
          }))
        mapped.reactions = mappedReactions
      }
    }

    const setFormattedText = (msgText: string, msgEntities: Api.TypeMessageEntity[]) => {
      mapped.text = msgText
      mapped.textAttributes = TelegramMapper.mapTextAttributes(msgText, msgEntities)
    }
    const pushSticker = async (sticker: Api.Document, messageId: number) => {
      const animated = sticker.mimeType === 'application/x-tgsticker'
      mapped.attachments = mapped.attachments || []
      mapped.attachments.push({
        id: sticker.id.toString(),
        srcURL: await this.getMediaUrl(sticker.id, messageId),
        mimeType: animated ? 'image/tgs' : undefined,
        type: MessageAttachmentType.IMG,
        isGif: true,
        isSticker: true,
        size: { width: 512, height: 512 },
        extra: {
          loop: animated,
        },
      })
    }

    const mapMessageMedia = async () => {
      if (msg.photo) {
        const { photo } = msg
        mapped.attachments = mapped.attachments || []
        mapped.attachments.push({
          id: String(photo.id),
          srcURL: await this.getMediaUrl(photo.id, msg.id),
          type: MessageAttachmentType.IMG,
        })
      } else if (msg.video) {
        const { video } = msg
        mapped.attachments = mapped.attachments || []
        mapped.attachments.push({
          id: String(video.id),
          srcURL: await this.getMediaUrl(video.id, msg.id),
          type: MessageAttachmentType.VIDEO,
          fileName: video.accessHash.toString(),
          mimeType: video.mimeType,
          size: video.videoThumbs ? { width: video.videoThumbs[0].w, height: video.videoThumbs[0].h } : undefined,
        })
      } else if (msg.audio) {
        const { audio } = msg
        mapped.attachments = mapped.attachments || []
        mapped.attachments.push({
          id: String(audio.id),
          srcURL: await this.getMediaUrl(audio.id, msg.id),
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
          srcURL: await this.getMediaUrl(videoNote.id, msg.id),
          type: MessageAttachmentType.VIDEO,
        })
      } else if (msg.voice) {
        const { voice } = msg
        mapped.attachments = mapped.attachments || []
        mapped.attachments.push({
          id: String(voice.id),
          srcURL: await this.getMediaUrl(voice.id, msg.id),
          type: MessageAttachmentType.AUDIO,
        })
      } else if (msg.gif) {
        const animation = msg.gif
        mapped.attachments = mapped.attachments || []
        const size = animation.thumbs[0] as Api.PhotoSize
        mapped.attachments.push({
          id: String(animation.id),
          srcURL: await this.getMediaUrl(animation.id, msg.id),
          type: MessageAttachmentType.VIDEO,
          isGif: true,
          fileName: animation.accessHash.toString(),
          mimeType: animation.mimeType,
          size: { width: size.w, height: size.h },
        })
      } else if (msg.sticker) {
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
      } else if (msg.document) {
        const { document } = msg
        mapped.attachments = mapped.attachments || []
        const fileName = (document.attributes.find(f => f instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename)?.fileName
          ?? document.accessHash.toString()
        mapped.attachments.push({
          id: String(document.id),
          type: MessageAttachmentType.UNKNOWN,
          srcURL: await this.getMediaUrl(document.id, msg.id),
          fileName,
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
        mapped.textHeading = `${poll.poll.publicVoters ? 'Anonymous ' : ''}Poll\n\n
          
    ${poll.results.results.map((result, index) => [pollAnswers[index], result.chosen
    ? '✔️'
    : '', `— ${(result.voters / poll.results.totalVoters) * 100}%`, `(${result.voters})`].filter(Boolean).join('\t')).join('\n')}`
      } else if (msg.media instanceof Api.MessageMediaWebPage) {
        mapped.links = [this.mapMessageLink(msg.media.webpage, msg.id)]
      } else {
        mapped.textHeading = `Unsupported Telegram media ${msg.media?.className}`
      }
    }

    const mapMessageService = () => {
      if (msg.action instanceof Api.MessageActionPhoneCall) {
        mapped.textHeading = [
          `${msg.action.video ? '🎥 Video ' : '📞 '}Call`,
          msg.action.duration ? msg.action.duration.toString() : '',
          TelegramMapper.mapCallReason(msg.action.reason),
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
      } else if (msg.action instanceof Api.MessageActionChatDeleteUser) {
        mapped.text = `{{${msg.action.userId}}} left the group`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.THREAD_PARTICIPANTS_REMOVED,
          participantIDs: [String(msg.action.userId)],
          actorParticipantID: undefined,
        }
      } else if (msg.action instanceof Api.MessageActionChatJoinedByLink) {
        mapped.text = '{{sender}} joined the group via invite link'
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.THREAD_PARTICIPANTS_ADDED,
          participantIDs: [mapped.senderID],
          actorParticipantID: undefined,
        }
      } else if (msg.action instanceof Api.ChannelAdminLogEventActionChangePhoto) {
        mapped.text = '{{sender}} updated the group photo'
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.THREAD_IMG_CHANGED,
          actorParticipantID: mapped.senderID,
        }
      } else if (msg.action instanceof Api.MessageActionChatDeletePhoto) {
        mapped.text = '{{sender}} deleted the group photo'
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.THREAD_IMG_CHANGED,
          actorParticipantID: mapped.senderID,
        }
      } else if (msg.action instanceof Api.MessageActionChatCreate || msg.action instanceof Api.MessageActionChannelCreate) {
        mapped.text = `{{sender}} created the group "${msg.chat.id}"`
        mapped.isAction = true
        mapped.parseTemplate = true
        mapped.action = {
          type: MessageActionType.GROUP_THREAD_CREATED,
          actorParticipantID: mapped.senderID,
          title: msg.chat.id.toString(),
        }
      } else if (msg.action instanceof Api.MessageActionChatMigrateTo) {
        mapped.text = `{{sender}} created the group "${msg.chat.id}"`
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
      } else {
        mapped.textHeading = `Unsupported Telegram message ${msg.media?.className} ${msg.action?.className}`
      }
    }

    if (msg.text) {
      setFormattedText(msg.rawText, msg.entities)
      if (msg.webPreview) {
        mapped.links = [this.mapMessageLink(msg.webPreview, msg.id)]
      }
    }
    if (msg.reactions) {
      setReactions(msg.reactions)
    }
    if (msg.media) {
      await mapMessageMedia()
    }

    if (msg instanceof Api.MessageService) {
      mapMessageService()
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

  async mapUser(user: Api.User): Promise<User> {
    if (!user) return
    const imgURL = await this.getProfilePhotoUrl(user.id)
    return {
      id: user.id.toString(),
      username: user.username,
      phoneNumber: user.phone ? '+' + user.phone : undefined,
      isVerified: user.verified,
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
      imgURL,
    }
  }

  mapMuteFor = (seconds: number) => {
    if (seconds >= MUTED_FOREVER_CONSTANT) return 'forever'
    if (seconds === 0) return
    return addSeconds(new Date(), seconds)
  }

  async mapThread(dialog: Dialog, messages: Message[]): Promise<Thread> {
    const imgFile = await this.getProfilePhotoUrl(dialog.id)
    const t: Thread = {
      _original: stringifyCircular(dialog),
      id: String(getPeerId(dialog.id)),
      type: dialog.dialog.peer instanceof Api.PeerUser ? 'single' : 'group',
      timestamp: messages[0]?.timestamp,
      isUnread: dialog.unreadCount !== 0,
      isReadOnly: false,
      lastReadMessageID: String(Math.max(dialog.dialog.readInboxMaxId, dialog.dialog.readOutboxMaxId)),
      mutedUntil: this.mapMuteFor(dialog.dialog.notifySettings.muteUntil),
      imgURL: imgFile,
      title: dialog.title,
      messages: {
        hasMore: true,
        oldestCursor: messages[0]?.id || '',
        items: messages,
      },
      participants: {
        hasMore: false,
        items: [],
      },
    }
    return t
  }

  mapMessages = async (messages: Api.Message[]) =>
    Promise.all(messages.sort((a, b) => a.date - b.date).map(m => this.mapMessage(m)))

  // https://github.com/evgeny-nadymov/telegram-react/blob/afd90f19b264895806359c23f985edccda828aca/src/Utils/Chat.js#L445
}
