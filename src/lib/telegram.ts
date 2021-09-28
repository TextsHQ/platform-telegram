import MTProto from '@mtproto/core'
import path from 'path'
import { sleep } from '@mtproto/core/src/utils/common'

import { API_HASH, API_ID } from '../constants';

export default class TelegramAPI {
  api: MTProto

  constructor () {
    this.api = new MTProto({
      test: true,
      api_id: API_ID,
      api_hash: API_HASH,
      storageOptions: {
        // FIXME: use texts path
        path: path.resolve(__dirname, './data/1.json'),
      },
    });
  }

  setInstance = (apiInstance: MTProto) => this.api = apiInstance

  getInstance = () => null

  /**
   * @see https://mtproto-core.js.org/docs/setup-handle-errors
   */
  call = async (method, params, options = {}): Promise<any> => {
    try {
      const result = await this.api.call(method, params, options);
      return result;
    } catch (error) {
      const { error_code, error_message } = error;

      if (error_code === 420) {
        const seconds = Number(error_message.split('FLOOD_WAIT_')[1]);
        const ms = seconds * 1000;

        await sleep(ms);

        return this.call(method, params, options);
      }

      if (error_code === 303) {
        const [type, dcIdAsString] = error_message.split('_MIGRATE_');
        const dcId = Number(dcIdAsString);

        if (type === 'PHONE') await this.api.setDefaultDc(dcId);
        else Object.assign(options, { dcId });

        return this.call(method, params, options);
      }

      if (error_code === 500 && error_message === 'AUTH_RESTART') {
        return this.call(method, params, options);
      }

      console.log(error)
      throw new Error(error)
    }
  }

  getPhoneCodeHash = async (phoneNumber: string): Promise<string> => {
    const { phone_code_hash } = await this.call('auth.sendCode', {
      phone_number: phoneNumber,
      settings: { _: 'codeSettings' },
    });

    return phone_code_hash
  }
  
  login = async ({ code, phone, codeHash }: { code: string; phone: string; codeHash: string; }) => {
    const signInResult = await this.call('auth.signIn', {
      phone_code: code,
      phone_number: phone,
      phone_code_hash: codeHash,
    });

    if (signInResult._ === 'auth.authorizationSignUpRequired') {
      return { error: true, code: 'auth.authorizationSignUpRequired' }
    }

    return signInResult
  }

  register = async (credentials: { 
    code: string; 
    phone: string; 
    codeHash: string; 
    firstName: string; 
    lastName: string; 
  }) => {
    await this.call('auth.signUp', {
      phone_number: credentials.phone,
      phone_code_hash: credentials.codeHash,
      first_name: credentials.firstName,
      last_name: credentials.lastName,
    });
  }

  getCurrentUser = async (): Promise<any> => {
    try {
      const user = await this.call('users.getFullUser', {
        id: { _: 'inputUserSelf' },
      });
  
      return user
    } catch (error) {
      return null
    }
  }

  getThreads = async () => {
    const threads = await this.call('channels.GetChannels', {
      id: [0x40f202fd],
    });

    return threads
  }
}