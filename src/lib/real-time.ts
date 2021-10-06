import { OnServerEventCallback, ServerEventType } from "@textshq/platform-sdk";
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
        const event: Api.UpdateNewMessage = update as Api.UpdateNewMessage
        // TODO: Use STATE_SYNC instead of refreshing messages
        this.onEvent([{
          type: ServerEventType.THREAD_MESSAGES_REFRESH,
          // @ts-expect-error
          threadID: `${event.chatId}` || `${event.userId}`,
        }])
      }
    });
  }
}
