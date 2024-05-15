import { setTimeout as sleep } from 'timers/promises'
import { texts } from '@textshq/platform-sdk'
import { Api, errors, TelegramClient } from 'telegram'
import { getPeerId } from 'telegram/Utils'
import { LogLevel } from 'telegram/extensions/Logger'
import { Dialog } from 'telegram/tl/custom/dialog'
import { createInputPeer } from './util'

export class CustomClient extends TelegramClient {
  override async invoke<R extends Api.AnyRequest>(request: R, dcId?: number): Promise<R['__response']> {
    try {
      const result = await super.invoke(request, dcId)
      return result
    } catch (err) {
      // https://github.com/gram-js/gramjs/blob/07e7e22b6d5294236479219930bde66290a0837a/gramjs/client/users.ts#L58
      if (err instanceof errors.FloodWaitError || err instanceof errors.FloodTestPhoneWaitError) {
        texts.Sentry.captureException(err)
        // replicate default behavior for < seconds
        if (err.seconds <= 300) {
          texts.error(new Date().toLocaleString(), `Sleeping for ${err.seconds}s for ${request.className}`, request)
          await sleep((err.seconds * 1_000) + 1_000)
          const result = await super.invoke(request, dcId)
          return result
        }
        texts.error(err, request)
      }
      throw err
    }
  }

  /**
   * This function uses the same logic as `iterDialogs` from GramJS. Unfortunately,
   * they don't provide a utility to easily create a GramJS Dialog (different from MTProto dialog), so the logic was copied
   * from GramJS and modified here.
   */
  public async getPeerDialog(id: string, accessHash?: string) {
    const inputPeer = createInputPeer(id, accessHash)
    const result = await this.invoke(new Api.messages.GetPeerDialogs({
      peers: [new Api.InputDialogPeer({
        peer: inputPeer,
      })],
    }))

    if (!result) return
    const tlDialog = result.dialogs[0]
    const tlDialogMessageKey = this._dialogMessageKey(tlDialog.peer, tlDialog.topMessage)

    const entities = new Map<string, Api.TypeUser | Api.TypeChat>()
    let message: Api.Message | undefined

    for (const entity of [...result.users, ...result.chats]) {
      if (entity instanceof Api.UserEmpty || entity instanceof Api.ChatEmpty) continue
      entities.set(getPeerId(entity), entity)
    }

    for (const m of result.messages) {
      const tempMessage = m as unknown as Api.Message
      try {
        if (tempMessage && '_finishInit' in tempMessage) {
          tempMessage._finishInit(this, entities, undefined)
        }
      } catch (e) {
        this._log.error('Got error while trying to finish init message with id ' + m.id)
        if (this._log.canSend(LogLevel.ERROR)) console.error(e)
        if (this._errorHandler) await this._errorHandler(e as Error)
      }

      if (this._dialogMessageKey(tempMessage.peerId!, tempMessage.id) === tlDialogMessageKey) {
        message = tempMessage
        break
      }
    }
    if (tlDialog instanceof Api.DialogFolder) return
    const peerId = getPeerId(tlDialog.peer)
    if (!entities.has(peerId)) return
    return new Dialog(this, tlDialog, entities, message)
  }

  /**
   * From GramJS' `iterDialogs` implementation:
   *
   * Get the key to get messages from a dialog.
   *
   * We cannot just use the message ID because channels share message IDs,
   * and the peer ID is required to distinguish between them. But it is not
   * necessary in small group chats and private chats.
   * @param {Api.TypePeer} [peer] the dialog peer
   * @param {number} [messageId] the message id
   * @return {[number,number]} the channel id and message id
   */
  // eslint-disable-next-line class-methods-use-this
  private _dialogMessageKey(peer: Api.TypePeer, messageId: number): string {
    return (
      ''
      + [
        peer instanceof Api.PeerChannel ? peer.channelId : undefined,
        messageId,
      ]
    )
  }
}
