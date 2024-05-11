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
  <rect width="16" height="16" fill="#179CDE" rx="5"/>
  <path fill="#fff" fill-rule="evenodd" d="M2.55 7.818a470.388 470.388 0 0 1 5.956-2.74c2.837-1.259 3.426-1.477 3.81-1.485.085-.001.274.021.397.127a.47.47 0 0 1 .145.295c.013.085.03.279.017.43-.154 1.724-.819 5.908-1.157 7.839-.143.817-.425 1.09-.698 1.118-.594.058-1.044-.419-1.619-.82-.899-.63-1.406-1.021-2.28-1.635-1.008-.71-.354-1.1.22-1.737.151-.167 2.765-2.704 2.815-2.934.007-.03.013-.137-.047-.193-.06-.057-.148-.037-.212-.022-.09.022-1.526 1.035-4.308 3.04-.408.299-.777.444-1.108.437-.365-.009-1.066-.22-1.588-.401-.64-.222-1.148-.34-1.104-.717.023-.196.277-.397.76-.602Z" clip-rule="evenodd"/>
  </svg>`,
  brand: {
    background: '#179CDE',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 48 48">
    <path fill="black" fill-rule="evenodd" d="M7.648 23.453c8.933-4.154 14.89-6.893 17.87-8.216 8.511-3.779 10.28-4.435 11.432-4.457.254-.005.82.062 1.188.38.31.269.395.632.436.886.04.255.092.835.051 1.288-.461 5.172-2.457 17.724-3.472 23.518-.43 2.45-1.275 3.273-2.094 3.353-1.78.175-3.131-1.255-4.855-2.461-2.697-1.888-4.22-3.062-6.838-4.904-3.026-2.128-1.065-3.298.66-5.21.45-.5 8.292-8.113 8.444-8.803.018-.087.036-.409-.143-.579-.18-.17-.444-.111-.635-.065-.27.065-4.579 3.105-12.926 9.12-1.223.896-2.33 1.333-3.323 1.31-1.094-.025-3.199-.66-4.763-1.203-1.92-.666-3.445-1.018-3.312-2.15.07-.588.829-1.19 2.28-1.807Z" clip-rule="evenodd"/>
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
    Attribute.SUPPORTS_QUOTED_MESSAGES_FROM_ANY_THREAD,
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
