import { FaTelegram } from 'react-icons/fa'
import { MessageDeletionMode, Platform } from '@textshq/platform-sdk'

const info: Platform = {
  name: 'telegram',
  version: '1.0.0',
  displayName: 'Telegram',
  icon: FaTelegram as any,
  loginMode: 'manual',
  supportedReactions: [],
  deletionMode: MessageDeletionMode.UNSUPPORTED,
  attributes: new Set(),
}

export default info
