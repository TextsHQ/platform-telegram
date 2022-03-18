/* eslint-disable @typescript-eslint/no-throw-literal */
import { AccountInfo, ReAuthError, texts } from '@textshq/platform-sdk'
import { Airgram } from 'airgram'
import path from 'path'
import { Api, TelegramClient } from 'telegram'
import os from 'os'
import fs from 'fs/promises'
import { API_ID, API_HASH, tdlibPath } from './constants'
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

  migrateAirgramSession = async (dataDirPath: string, newClient: TelegramClient, dbSession: DbSession) => {
    const done = async () => {
      texts.log('[airgram migration] success')
      dbSession.save()
      await this.airgramConn.api.logOut()
      await this.airgramConn.api.close()
      await this.airgramConn.destroy()
      await fs.rm(path.join(dataDirPath, 'db'), { recursive: true }).catch()
      await fs.rm(path.join(dataDirPath, 'files'), { recursive: true }).catch()
    }
    try {
      const qrToken = await newClient.invoke(new Api.auth.ExportLoginToken({
        apiId: API_ID,
        apiHash: API_HASH,
        exceptIds: [],
      }))
      if (!qrToken) return
      texts.log('[airgram migration]', qrToken)
      if (qrToken.className !== 'auth.LoginToken') return
      const token = `tg://login?token=${qrToken.token.toString('base64url')}`
      const confirmResult = await this.airgramConn.api.confirmQrCodeAuthentication({ link: token })
      texts.log('[airgram migration]', confirmResult)
      const qrTokenResult = await newClient.invoke(new Api.auth.ExportLoginToken({
        apiId: API_ID,
        apiHash: API_HASH,
        exceptIds: [],
      }))
      texts.log('[airgram migration]', qrTokenResult)
      if (qrTokenResult.className === 'auth.LoginTokenSuccess') {
        return await done()
      }
      if (qrTokenResult.className === 'auth.LoginTokenMigrateTo') {
        texts.log('[airgram migration]', 'migrating DC')
        await newClient._switchDC(qrTokenResult.dcId)
        const migratedToken = await newClient.invoke(new Api.auth.ImportLoginToken({ token: qrTokenResult.token }))
        if (migratedToken.className === 'auth.LoginTokenSuccess') {
          return await done()
        }
      }
    } catch (err) {
      texts.Sentry.captureException(err)
      throw new ReAuthError(err)
    }
    throw new ReAuthError()
  }
}
