import { texts } from '@textshq/platform-sdk'
import { Api, errors, TelegramClient } from 'telegram'
import { sleep } from 'telegram/Helpers'
import type { MTProtoSender } from 'telegram/network'

export class CustomClient extends TelegramClient {
  override async invoke<R extends Api.AnyRequest>(
    request: R,
    sender?: MTProtoSender,
  ): Promise<R['__response']> {
    try {
      const result = await super.invoke(request, sender)
      return result
    } catch (e) {
      if (
        e instanceof errors.FloodWaitError
        || e instanceof errors.FloodTestPhoneWaitError
      ) {
        texts.Sentry.captureException(e)
        // replicate default behavior for < seconds
        if (e.seconds <= 300) {
          texts.log(`Sleeping for ${e.seconds}s for ${request.className}`)
          await sleep(e.seconds * 1000)
          const result = await super.invoke(request, sender)
          return result
        }
      }
      throw e
    }
  }
}
