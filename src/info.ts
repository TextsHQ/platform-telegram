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
  <rect width="16" height="16" rx="5" fill="#179CDE"/>
  <path fill="#fff" fill-rule="evenodd" d="M3.074 7.905a428.203 428.203 0 0 1 5.248-2.26c2.5-1.04 3.02-1.221 3.358-1.227a.592.592 0 0 1 .348.105.38.38 0 0 1 .128.243c.012.07.027.23.015.355-.135 1.423-.721 4.876-1.02 6.47-.125.675-.374.9-.614.923-.523.048-.92-.345-1.426-.677-.792-.52-1.24-.843-2.008-1.35-.889-.585-.313-.907.193-1.433.133-.137 2.436-2.232 2.48-2.422.006-.024.011-.112-.042-.16-.052-.046-.13-.03-.186-.017-.08.018-1.345.854-3.796 2.509-.36.247-.685.367-.976.36-.322-.006-.94-.181-1.4-.33-.563-.184-1.01-.28-.972-.592.02-.162.244-.328.67-.497Z" clip-rule="evenodd"/>
  </svg>
  `,
  brand: {
    background: '#179CDE',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 48 48">
      <path fill="black" fill-rule="evenodd" d="M4.295 23.62c10.495-4.573 17.493-7.587 20.995-9.043 9.997-4.159 12.075-4.881 13.428-4.905.298-.005.964.069 1.395.419.365.295.465.694.513.975.048.28.108.918.06 1.417-.542 5.692-2.886 19.506-4.079 25.882-.504 2.698-1.498 3.602-2.46 3.69-2.09.193-3.678-1.38-5.703-2.708-3.168-2.077-4.958-3.37-8.034-5.397-3.554-2.342-1.25-3.63.776-5.733.53-.55 9.74-8.93 9.92-9.69.021-.094.042-.449-.168-.636-.21-.187-.521-.123-.746-.072-.317.072-5.38 3.418-15.185 10.037-1.436.986-2.738 1.467-3.904 1.442-1.285-.028-3.758-.727-5.596-1.324-2.254-.733-4.046-1.12-3.89-2.365.081-.649.974-1.311 2.678-1.99Z" clip-rule="evenodd"/>
  </svg>`,
  },
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
