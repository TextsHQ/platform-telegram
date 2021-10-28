import { promises as fs } from 'fs'
import type { Api } from 'telegram'
import { VirtualClassName as VCN } from './types'

export const fileExists = (filePath: string) =>
  fs.access(filePath).then(() => true).catch(() => false)

export const IsObject = {
  userThread: (_: any): _ is Api.User => _.className === VCN.User,
  channel: (_: any): _ is Api.Channel => _.className === VCN.Channel,

  messagePhoto: (_: any): _ is Api.MessageMediaPhoto => _.className === VCN.MessageMediaPhoto,
  messageDocument: (_: any): _ is Api.MessageMediaDocument => _.className === VCN.MessageMediaDocument,
  messageService: (_: any): _ is Api.MessageService => _.className === VCN.MessageService,
  messageMediaWebPage: (_: any): _ is Api.MessageMediaWebPage => _.className === VCN.MessageMediaWebPage,

  document: (_?: any): _ is Api.Document => _?.className === VCN.Document,

  topPeers: (_: any): _ is Api.contacts.TopPeersDisabled => _.className === VCN.contacts_TopPeers,
  topPeersDisabled: (_: any): _ is Api.contacts.TopPeersDisabled => _.className === VCN.contacts_TopPeersDisabled
}
