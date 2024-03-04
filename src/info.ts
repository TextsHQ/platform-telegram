import { MessageDeletionMode, PlatformInfo, Attribute } from '@textshq/platform-sdk'
import type { SupportedReaction } from '@textshq/platform-sdk'

const reactions: Record<string, SupportedReaction> = {
  '👍': { title: '👍', render: '👍' },
  '👎': { title: '👎', render: '👎' },
  '❤️': { title: '❤️', render: '❤️' },
  '🔥': { title: '🔥', render: '🔥' },
  '🥰': { title: '🥰', render: '🥰' },
  '💯': { title: '💯', render: '💯' },
  '🎉': { title: '🎉', render: '🎉' },
  '🤩': { title: '🤩', render: '🤩' },
  '😱': { title: '😱', render: '😱' },
  '😁': { title: '😁', render: '😁' },
  '🤔': { title: '🤔', render: '🤔' },
  '🤯': { title: '🤯', render: '🤯' },
  '😢': { title: '😢', render: '😢' },
  '🤬': { title: '🤬', render: '🤬' },
  '💩': { title: '💩', render: '💩' },
  '🤮': { title: '🤮', render: '🤮' },
}

const info: PlatformInfo = {
  name: 'telegram',
  version: '1.0.1',
  displayName: 'Telegram',
  icon: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 16 16">
  <path fill="#179CDE" d="M11 0H5a5 5 0 0 0-5 5v6a5 5 0 0 0 5 5h6a5 5 0 0 0 5-5V5a5 5 0 0 0-5-5Z"/>
  <path fill="#fff" fill-rule="evenodd" d="M3.074 7.905a428.203 428.203 0 0 1 5.248-2.26c2.5-1.04 3.02-1.221 3.358-1.227a.592.592 0 0 1 .348.105.38.38 0 0 1 .128.243c.012.07.027.23.015.355-.135 1.423-.721 4.876-1.02 6.47-.125.675-.374.9-.614.923-.523.048-.92-.345-1.426-.677-.792-.52-1.24-.843-2.008-1.35-.889-.585-.313-.907.193-1.433.133-.137 2.436-2.232 2.48-2.422.006-.024.011-.112-.042-.16-.052-.046-.13-.03-.186-.017-.08.018-1.345.854-3.796 2.509-.36.247-.685.367-.976.36-.322-.006-.94-.181-1.4-.33-.563-.184-1.01-.28-.972-.592.02-.162.244-.328.67-.497Z" clip-rule="evenodd"/>
  </svg>
  `,
  loginMode: 'custom',
  deletionMode: MessageDeletionMode.DELETE_FOR_EVERYONE,
  typingDurationMs: 5_000,
  attributes: new Set([
    Attribute.CAN_MESSAGE_USERNAME,
    Attribute.CAN_MESSAGE_PHONE_NUMBER,
    Attribute.SHARES_CONTACTS,
    Attribute.SUPPORTS_ARCHIVE,
    Attribute.SUPPORTS_DELETE_THREAD,
    Attribute.SUPPORTS_REPORT_THREAD,
    Attribute.SUPPORTS_EDIT_MESSAGE,
    Attribute.SUPPORTS_FORWARD,
    Attribute.SUPPORTS_LIVE_TYPING,
    Attribute.SUPPORTS_MARK_AS_UNREAD,
    Attribute.SUPPORTS_QUOTED_MESSAGES,
    Attribute.SUPPORTS_PUSH_NOTIFICATIONS,
    Attribute.GROUP_THREAD_CREATION_REQUIRES_TITLE,
    Attribute.SUPPORTS_PRESENCE,
    Attribute.SUBSCRIBE_TO_ONLINE_OFFLINE_ACTIVITY,
    Attribute.SUPPORTS_MESSAGE_EXPIRY,
    Attribute.SUPPORTS_GROUP_PARTICIPANT_ROLE_CHANGE,
    Attribute.SUBSCRIBE_TO_THREAD_SELECTION,
    Attribute.CAN_FETCH_LINK_PREVIEW,
    Attribute.CAN_REMOVE_LINK_PREVIEW,
  ]),
  attachments: {
    supportsCaption: true,
    supportsStickers: true,
    recordedAudioMimeType: 'audio/ogg',
    gifMimeType: 'video/mp4',
    maxSize: {
      image: 4 * 1024 * 1024 * 1024,
      video: 4 * 1024 * 1024 * 1024,
      audio: 4 * 1024 * 1024 * 1024,
      files: 4 * 1024 * 1024 * 1024,
    },
  },
  reactions: {
    supported: reactions,
    allowsMultipleReactionsToSingleMessage: false,
  },
  notifications: {
    web: {},
    apple: {},
  },
  getUserProfileLink: ({ username }) =>
    (username ? `https://t.me/${username}` : null),
  extra: {
    macOSAppBundleIDs: [
      'ru.keepcoder.Telegram', // native mac
      'com.tdesktop.Telegram', // tg desktop
    ],
  },
}

export default info
