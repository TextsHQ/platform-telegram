import { OnServerEventCallback, ServerEvent, ServerEventType } from "@textshq/platform-sdk";
import type { Api } from "telegram";

import type TelegramAPI from "./telegram";

export default class TelegramRealTime {
  constructor (
    private readonly api: TelegramAPI, 
    private onEvent: OnServerEventCallback,
  ) {}

  subscribeToEvents = async (): Promise<void> => {
    this.api.api.addEventHandler((update: Api.TypeUpdate) => {
      console.log(update)

      if (update.className === 'UpdateNewMessage') {
        const event: Api.UpdateNewMessage = update as Api.UpdateNewMessage
        // TODO: Use STATE_SYNC instead of refreshing messages
        this.onEvent([{
          type: ServerEventType.THREAD_MESSAGES_REFRESH,
          threadID: event.message.peerId?.className === 'PeerUser' 
            // @ts-expect-error  
            ? `${event.message.peerId.userId}`
            // @ts-expect-error
            : `${event.message.peerId.chatId}`,
        }])
      }

      if (update.className === 'UpdateShortChatMessage') {
        const event: Api.UpdateShortChatMessage = update as Api.UpdateShortChatMessage
        // TODO: Use STATE_SYNC instead of refreshing messages
        this.onEvent([{
          type: ServerEventType.THREAD_MESSAGES_REFRESH,
          threadID: `${event.chatId}`,
        }])
      }

      if (update.className === 'UpdateShortMessage') {
        const event: Api.UpdateShortMessage = update as Api.UpdateShortMessage
        // TODO: Use STATE_SYNC instead of refreshing messages
        this.onEvent([{
          type: ServerEventType.THREAD_MESSAGES_REFRESH,
          threadID: `${event.userId}`,
        }])
      }
      // FIXME: Get threadID somehow 
      // @see https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1update_delete_messages.html
      // @see https://core.telegram.org/constructor/updateDeleteMessages
      // if (update.className === 'UpdateDeleteMessages') {
      //   const event: Api.UpdateDeleteMessages = update as Api.UpdateDeleteMessages
      //   const events: ServerEvent = { 
      //     type: ServerEventType.STATE_SYNC,
      //     objectIDs: { threadID },
      //     objectName: 'message',
      //     mutationType: 'delete',
      //     entries: event.messages.map(message => String(message)), 
      //   }

      //   this.onEvent([events])
      // }
    });
  }
}
