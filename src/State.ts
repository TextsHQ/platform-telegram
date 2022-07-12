import type { User } from '@textshq/platform-sdk'
import { Mutex, Semaphore } from 'async-mutex'
import type { Api } from 'telegram'
import type { Dialog } from 'telegram/tl/custom/dialog'
import type { DbSession } from './dbSession'

interface LocalState {
  pts: number
  date: number
  updateMutex: Mutex
  cancelDifference?: boolean
  watchdogTimeout?: NodeJS.Timeout
}

export enum AuthState {
  PHONE_INPUT,
  CODE_INPUT,
  PASSWORD_INPUT,
  READY,
}

export class TelegramState {
  dispose() {
    clearInterval(this.localState.watchdogTimeout)
  }

  public authState: AuthState

  public dbSession: DbSession

  public dialogs: Map<string, Dialog> = new Map<string, Dialog>()

  public messageMediaStore = new Map<number, Api.TypeMessageMedia>()

  public messageChatIdMap = new Map<number, string>()

  public dialogIdToParticipantIds = new Map<string, Set<string>>()

  public localState: LocalState

  public me: Api.User

  public meMapped: User

  public sessionName: string

  public downloadMediaSemaphore = new Semaphore(5)

  public profilePhotoSemaphore = new Semaphore(5)
}
