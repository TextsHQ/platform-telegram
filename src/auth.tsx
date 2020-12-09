import React, { FormEvent, ChangeEvent } from 'react'
import { isPossiblePhoneNumber } from 'react-phone-number-input'
import PhoneInput from 'react-phone-number-input/input'
import { PlatformAPI, LoginCreds, LoginResult } from '@textshq/platform-sdk'

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
    setLoading(true)
    const result = await login({ custom: { phoneNumber, code } })
    if (result.type === 'code_required') {
      setShow(['code'])
    }
    setLoading(false)
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
          <>
            <div>Authentication code has been sent to {phoneNumber}</div>
            <label>
              <span>Code</span>
              <input onChange={onCodeChange} value={code} />
            </label>
          </>
        )}
        <label>
          <button type="submit" disabled={submitDisabled}>{loading ? '...' : 'Login to Telegram'}</button>
        </label>
      </form>
    </div>
  )
}

export default TelegramAuth
