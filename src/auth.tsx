import type { FormEvent, ChangeEvent } from 'react'
// import PhoneInput from 'react-phone-number-input'
import { PlatformAPI, LoginCreds, LoginResult } from '@textshq/platform-sdk'

const { React } = globalThis.texts

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
  const onPhoneNumberChange = (ev: ChangeEvent<HTMLInputElement>) => {
    setPhoneNumber(ev.target.value)
  }
  const onCodeChange = (ev: ChangeEvent<HTMLInputElement>) => {
    setCode(ev.target.value)
  }
  return (
    <div className="auth telegram-auth">
      <form onSubmit={onSubmit}>
        {show.includes('phone') && (
          <label>
            <span>Phone Number</span>
            <input onChange={onPhoneNumberChange} value={phoneNumber} />
          </label>
        )}
        {show.includes('code') && (
          <label>
            <span>Code</span>
            <input onChange={onCodeChange} value={code} />
          </label>
        )}
        <label>
          <button type="submit">{loading ? '...' : 'Login to Telegram'}</button>
        </label>
      </form>
    </div>
  )
}

export default TelegramAuth
