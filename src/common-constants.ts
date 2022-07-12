import type { SupportedReaction } from '@textshq/platform-sdk'

export const REACTIONS: Record<string, SupportedReaction> = {
  thumbsUp: { title: 'Thumbs Up', render: '👍' },
  thumbsDown: { title: 'Thumbs Down', render: '👎' },
  heart: { title: 'Red Heart', render: '❤️' },
  fire: { title: 'Fire', render: '🔥' },
  smilingHearts: { title: 'Smiling Face with Hearts', render: '🥰' },
  partyPopper: { title: 'Party Popper', render: '🎉' },
  starStruckt: { title: 'Star-Struck', render: '🤩' },
  screaming: { title: 'Screaming Face', render: '😱' },
  beaming: { title: 'Beaming Face', render: '😁' },
  thinking: { title: 'Thinking Face', render: '🤔' },
  explodingHead: { title: 'Exploding Head', render: '🤯' },
  crying: { title: 'Crying Face', render: '😢' },
  faceSwearing: { title: 'Face with Symbols on Mouth', render: '🤬' },
  poo: { title: 'Pile of Poo', render: '💩' },
  vomiting: { title: 'Face Vomiting', render: '🤮' },
}
