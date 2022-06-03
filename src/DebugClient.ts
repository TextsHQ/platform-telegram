import { texts } from '@textshq/platform-sdk'
import { Api, TelegramClient } from 'telegram'
import type { IterParticipantsParams } from 'telegram/client/chats'
import type { IterDialogsParams, _DialogsIter } from 'telegram/client/dialogs'
import type { EntityLike } from 'telegram/define'
import type { TotalList } from 'telegram/Helpers'
import type { Dialog } from 'telegram/tl/custom/dialog'

export class DebugClient extends TelegramClient {
  async getParticipants(entity: EntityLike, params: IterParticipantsParams): Promise<TotalList<Api.User>> {
    texts.log('getParticipants')
    // const err = new Error()
    // texts.log(err.stack)
    return super.getParticipants(entity, params)
  }

  getDialogs(params: IterDialogsParams): Promise<TotalList<Dialog>> {
    texts.log('getDialogs')
    return super.getDialogs(params)
  }

  iterDialogs(iterDialogsParams: IterDialogsParams): _DialogsIter {
    texts.log('iterDialogs')
    return super.iterDialogs(iterDialogsParams)
  }
}
