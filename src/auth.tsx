import type { FormEvent, ChangeEvent } from 'react'
import { isPossiblePhoneNumber } from 'react-phone-number-input'
import PhoneInput from 'react-phone-number-input/input'
import { PlatformAPI, LoginCreds, LoginResult, texts } from '@textshq/platform-sdk'

const { React } = texts

const TelegramAuth: React.FC<{
  api: PlatformAPI
  login: (creds?: LoginCreds) => Promise<LoginResult>
}> = ({ api, login }) => {
  const [loading, setLoading] = React.useState(false)
  const [show, setShow] = React.useState(['phone'])
  const [phoneNumber, setPhoneNumber] = React.useState('')
  const [code, setCode] = React.useState('')
  const onSubmit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault()
    const result = await login({ custom: { phoneNumber, code } })
    if (result.type === 'code_required') {
      setShow(['code'])
    }
  }
  const onCodeChange = (ev: ChangeEvent<HTMLInputElement>) => {
    setCode(ev.target.value)
  }
  const submitDisabled = !isPossiblePhoneNumber(phoneNumber)
  return (
    <div className="auth telegram-auth">
      <form onSubmit={onSubmit}>
        {show.includes('phone') && (
          <label>
            <span>Phone Number</span>
            <PhoneInput onChange={setPhoneNumber} value={phoneNumber} />
          </label>
        )}
        {show.includes('code') && (
          <label>
            <span>Code</span>
            <input onChange={onCodeChange} value={code} />
          </label>
        )}
        <label>
      <button type="submit" disabled={submitDisabled}>{loading ? '...' : 'Login to Telegram'}</button>
        </label>
      </form>
    </div>
  )
}

export default TelegramAuth
