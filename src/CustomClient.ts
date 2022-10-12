import { texts } from '@textshq/platform-sdk'
import { Api, errors, TelegramClient } from 'telegram'
import { setTimeout as sleep } from 'timers/promises'
import type { MTProtoSender } from 'telegram/network'

export class CustomClient extends TelegramClient {
  // Rate limiters are stored in a map, where the key is the class name
  // and the value is the rate limiter: either a promise that resolves when the
  // rate limit is over (if initial rate limit was <300s), or a promise rejection
  // with the original error with a `rateLimitExpiresAt` property (timestamp)
  private rateLimits = new Map<Api.AnyRequest['className'], { originalError: errors.FloodWaitError | errors.FloodTestPhoneWaitError, rateLimitExpiresAt: number } | Promise<void>>()

  private inFlightRequests = new Map<Api.AnyRequest, Promise<Api.AnyRequest['__response']>>()

  override async invoke<R extends Api.AnyRequest>(
    request: R,
    sender?: MTProtoSender,
  ): Promise<R['__response']> {
    try {
      // If there is already an in-flight request for this exact request, return the same promise
      if (this.inFlightRequests.has(request)) {
        const result = await this.inFlightRequests.get(request)
        return result
      }

      // If there is a rate limit for this request class, wait for it to resolve
      if (this.rateLimits.has(request.className)) {
        const rateLimit = this.rateLimits.get(request.className)

        // If the rate limit is a promise, it means the wait time is <300s
        if (rateLimit instanceof Promise) {
          await rateLimit
        } else {
          // If it's not a Promise, we return the original error with a `rateLimitExpiresAt` property
          const { originalError, rateLimitExpiresAt } = rateLimit
          // calculate the new time remaining
          const seconds = rateLimitExpiresAt - Date.now()
          if (seconds > 0) { // if we still need to wait
            originalError.seconds = seconds // set the new time remaining
            throw originalError // if the new time is <300s, `catch` will sleep & retry
          }
        }
      }

      const promise = super.invoke(request, sender)
      this.inFlightRequests.set(request, promise)
      const result = await promise
      this.inFlightRequests.delete(request)
      this.rateLimits.delete(request.className) // Delete the rate limiter too if the request was successful
      return result
    } catch (err) {
      this.inFlightRequests.delete(request)

      // https://github.com/gram-js/gramjs/blob/07e7e22b6d5294236479219930bde66290a0837a/gramjs/client/users.ts#L58
      if (err instanceof errors.FloodWaitError || err instanceof errors.FloodTestPhoneWaitError) {
        texts.Sentry.captureException(err)
        // replicate default behavior for < seconds
        if (err.seconds <= 300) {
          texts.error(new Date().toLocaleString(), `Sleeping for ${err.seconds}s for ${request.className}`, request)
          const waiter = sleep((err.seconds * 1_000) + 1_000)
          this.rateLimits.set(request.className, waiter)
          await waiter
          this.rateLimits.delete(request.className)
          const result = await super.invoke(request, sender)
          return result
        }

        // if > 5 minutes, throw error for incoming requests until the rate limit is reset
        this.rateLimits.set(request.className, { originalError: err, rateLimitExpiresAt: Date.now() + (err.seconds * 1_000) })

        texts.error(err, request)
      }
      throw err
    }
  }
}
