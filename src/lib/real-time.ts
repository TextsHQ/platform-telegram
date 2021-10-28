import { OnServerEventCallback, ServerEvent, ServerEventType } from "@textshq/platform-sdk";
import type { Api } from "telegram";
import { VirtualClassName } from "../types";

import type TelegramAPI from "./telegram";

export default class TelegramRealTime {
  constructor (
    private readonly api: TelegramAPI,
    private onEvent: OnServerEventCallback,
  ) {}

  subscribeToEvents = async (): Promise<void> => {
    this.api.api.addEventHandler((update: Api.TypeUpdate) => {
      // TODO: Use STATE_SYNC instead of refreshing messages

      switch (update.className) {
        case VirtualClassName.UpdateNewMessage: {
          const event: Api.UpdateNewMessage = update as Api.UpdateNewMessage
          this.onEvent([{
            type: ServerEventType.THREAD_MESSAGES_REFRESH,
            // @ts-expect-error
            threadID: event.message.peerId?.className === VirtualClassName.PeerUser ? `${event.message.peerId.userId}` : `${event.message.peerId.chatId}`
          }])
          break
        }

        case VirtualClassName.UpdateShortChatMessage: {
          const event: Api.UpdateShortChatMessage = update as Api.UpdateShortChatMessage
          this.onEvent([{
            type: ServerEventType.THREAD_MESSAGES_REFRESH,
            threadID: `${event.chatId}`,
          }])
          break
        }

        case VirtualClassName.UpdateShortMessage: {
          const event: Api.UpdateShortMessage = update as Api.UpdateShortMessage
          // TODO: Use STATE_SYNC instead of refreshing messages
          this.onEvent([{
            type: ServerEventType.THREAD_MESSAGES_REFRESH,
            threadID: `${event.userId}`,
          }])

          break
        }
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
