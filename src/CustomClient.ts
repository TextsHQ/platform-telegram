import { setTimeout as sleep } from 'timers/promises'
import { texts } from '@textshq/platform-sdk'
import { Api, errors, TelegramClient } from 'telegram'
import type { MTProtoSender } from 'telegram/network'

export class CustomClient extends TelegramClient {
  override async invoke<R extends Api.AnyRequest>(request: R, sender?: MTProtoSender): Promise<R['__response']> {
    try {
      const result = await super.invoke(request, sender)
      return result
    } catch (err) {
      // https://github.com/gram-js/gramjs/blob/07e7e22b6d5294236479219930bde66290a0837a/gramjs/client/users.ts#L58
      if (err instanceof errors.FloodWaitError || err instanceof errors.FloodTestPhoneWaitError) {
        texts.Sentry.captureException(err)
        // replicate default behavior for < seconds
        if (err.seconds <= 300) {
          texts.error(new Date().toLocaleString(), `Sleeping for ${err.seconds}s for ${request.className}`, request)
          await sleep((err.seconds * 1_000) + 1_000)
          const result = await super.invoke(request, sender)
          return result
        }
        texts.error(err, request)
      }
      throw err
    }
  }
}
