/* eslint-disable @typescript-eslint/no-throw-literal */
import { AccountInfo, ReAuthError, texts } from '@textshq/platform-sdk'
import { Airgram } from 'airgram'
import path from 'path'
import { Api, TelegramClient } from 'telegram'
import os from 'os'
import { API_ID, API_HASH, BINARIES_DIR_PATH, tdlibPath } from './constants'
import type { DbSession } from './dbSession'

export type AirgramSession = { dbKey: string }

export const isAirgramSession = (session: string | AirgramSession): session is AirgramSession =>
  !!(session as AirgramSession)?.dbKey

export class AirgramMigration {
  private airgramConn: Airgram

  connectAirgramSession = async (session: AirgramSession, accountInfo: AccountInfo) => {
    try {
      this.airgramConn = new Airgram({
        databaseEncryptionKey: session.dbKey,
        apiId: API_ID,
        apiHash: API_HASH,
        command: tdlibPath,
        // deviceModel: undefined,
        applicationVersion: texts.constants.APP_VERSION,
        systemVersion: `${os.platform()} ${os.release()}`,
        logVerbosityLevel: texts.IS_DEV ? 2 : 0,
        useFileDatabase: true,
        useChatInfoDatabase: true,
        useMessageDatabase: true,
        useSecretChats: true,
        enableStorageOptimizer: true,
        ignoreFileNames: false,
        databaseDirectory: path.join(accountInfo.dataDirPath, 'db'),
        filesDirectory: path.join(accountInfo.dataDirPath, 'files'),
      })
      texts.log('Waiting for auth...')
      const authPromise = new Promise<void>((resolve, reject) => {
        this.airgramConn?.on('updateAuthorizationState', ({ update }) => {
          if (update.authorizationState._ === 'authorizationStateReady') {
            resolve()
          } else if (update.authorizationState._ === 'authorizationStateClosed') reject()
        })
      })
      await authPromise
      texts.log('Done auth')
    } catch (err) {
      texts.Sentry.captureException(err)
      throw new ReAuthError(err)
    }
    throw new ReAuthError()
  }

  migrateAirgramSession = async (newClient: TelegramClient, dbSession: DbSession) => {
    try {
      const qrToken = await newClient.invoke(new Api.auth.ExportLoginToken({
        apiId: API_ID,
        apiHash: API_HASH,
        exceptIds: [],
      }))
      if (qrToken) {
        texts.log(JSON.stringify(qrToken, null, 4))
        if (qrToken.className === 'auth.LoginToken') {
          const token = `tg://login?token=${qrToken.token.toString('base64url')}`
          const confirmResult = await this.airgramConn.api.confirmQrCodeAuthentication({ link: token })
          texts.log(JSON.stringify(confirmResult, null, 4))
          const qrTokenResult = await newClient.invoke(new Api.auth.ExportLoginToken({
            apiId: API_ID,
            apiHash: API_HASH,
            exceptIds: [],
          }))
          texts.log(JSON.stringify(qrTokenResult, null, 4))
          if (qrTokenResult.className === 'auth.LoginTokenSuccess') {
            texts.log('token success')
            await this.airgramConn.destroy()
            dbSession.save()
            return
          }
          if (qrTokenResult.className === 'auth.LoginTokenMigrateTo') {
            texts.log('migrating DC')
            await newClient._switchDC(qrTokenResult.dcId)
            const migratedToken = await newClient.invoke(new Api.auth.ImportLoginToken({ token: qrTokenResult.token }))
            if (migratedToken.className === 'auth.LoginTokenSuccess') {
              texts.log('token success')
              await this.airgramConn.destroy()
              dbSession.save()
              return
            }
          }
        }
      }
    } catch (err) {
      texts.Sentry.captureException(err)
      throw new ReAuthError(err)
    }
    throw new ReAuthError()
  }
}
