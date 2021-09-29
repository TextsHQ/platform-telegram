// import MTProto from '@mtproto/core'
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import path from 'path'
import { sleep } from '@mtproto/core/src/utils/common'

import { API_HASH as apiHash, API_ID as apiId } from '../constants';

export default class TelegramAPI {
  api: TelegramClient

  session: StringSession

  constructor () {}

  init = async (session = '') => {
    this.session = new StringSession(session)

    this.api = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
    });

    if (session) await this.api.connect();
  }

  getSessionSerialized = () => this.session.save()

  getPhoneCodeHash = async (phoneNumber: string): Promise<string> => {
    await this.api.connect()

    const res = await this.api.invoke(
      new Api.auth.SendCode({
        phoneNumber,
        apiHash,
        apiId,
        settings: new Api.CodeSettings({
          allowFlashcall: true,
          currentNumber: true,
          allowAppHash: true,
        }),
      })
    );

    return res?.phoneCodeHash
  }
  
  login = async ({ code, phone, codeHash }: { code: string; phone: string; codeHash: string; }) => {
    const signInResult = await this.api.start({
      phoneNumber: phone,
      phoneCode: async () => code,
      onError: (err) => console.log(err),
    });

    return signInResult
  }

  register = async (credentials: { 
    code: string; 
    phone: string; 
    codeHash: string; 
    firstName: string; 
    lastName: string; 
  }) => {
    return null
  }

  getCurrentUser = async (): Promise<Api.UserFull> => {
    try {
      const user = await this.api.invoke(
        new Api.users.GetFullUser({ id: new Api.InputUserSelf() })
      );

      return user
    } catch (error) {
      return null
    }
  }

  getThreads = async () => {
    try {
      const threads = await this.api.invoke(
        new Api.messages.GetAllChats({ exceptIds: [] })
      )
      return threads.chats
    } catch (error) {
      return []
    }
  }
}