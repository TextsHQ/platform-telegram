import MTProto from '@mtproto/core'
import path from 'path'
import { sleep } from '@mtproto/core/src/utils/common'

import { API_HASH, API_ID } from '../constants';

export default class TelegramAPI {
  api: MTProto

  constructor() {
    this.api = new MTProto({
      api_id: API_ID,
      api_hash: API_HASH,

      storageOptions: {
        path: path.resolve(__dirname, './data/1.json'),
      },
    });
  }

  async call(method, params, options = {}) {
    try {
      const result = await this.api.call(method, params, options);

      return result;
    } catch (error) {
      console.log(`${method} error:`, error);

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

        // If auth.sendCode call on incorrect DC need change default DC, because
        // call auth.signIn on incorrect DC return PHONE_CODE_EXPIRED error
        if (type === 'PHONE') {
          await this.api.setDefaultDc(dcId);
        } else {
          Object.assign(options, { dcId });
        }

        return this.call(method, params, options);
      }

      return Promise.reject(error);
    }
  }
  
  login = async () => {
    const { phone_code_hash } = await this.call('auth.sendCode', {
      phone_number: '+56976435585',
      settings: {
        _: 'codeSettings',
      },
    });

    console.log({phone_code_hash})
  }
}