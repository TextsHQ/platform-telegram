import React, { FormEvent } from 'react'
import { isPossiblePhoneNumber } from 'react-phone-number-input'
import PhoneInput from 'react-phone-number-input/input'
import type { PlatformAPI, LoginCreds, LoginResult } from '@textshq/platform-sdk'
import { AuthState } from './api'

const TelegramAuth: React.FC<{
  api: PlatformAPI
  login: (creds?: LoginCreds) => Promise<LoginResult>
}> = ({ api, login }) => {
  const [loading, setLoading] = React.useState(false)
  const [authState, setAuthState] = React.useState(AuthState.PHONE_INPUT)
  const [phoneNumber, setPhoneNumber] = React.useState('+')
  const [code, setCode] = React.useState('')
  const [password, setPassword] = React.useState('')
  const onSubmit = async (ev?: FormEvent<HTMLFormElement>) => {
    ev?.preventDefault()
    setLoading(true)
    await login({ custom: { phoneNumber, code, password } })
    setLoading(false)
  }
  React.useEffect(() => {
    api.onLoginEvent(state => {
      setAuthState(state)
      if (state === AuthState.READY) onSubmit()
    })
  }, [api])
  return (
    <div className="auth telegram-auth">
      <form onSubmit={onSubmit}>
        {authState === AuthState.PHONE_INPUT && (
          <label>
            <span>Phone Number</span>
            <PhoneInput onChange={value => setPhoneNumber(value ? value.toString() : '')} value={phoneNumber} autoFocus />
          </label>
        )}
        {authState === AuthState.CODE_INPUT && (
          <>
            <div>Authentication code has been sent to {phoneNumber} (check your Telegram app)</div>
            <label>
              <span>Code</span>
              <input type="number" onChange={ev => setCode(ev.target.value)} value={code} autoFocus />
            </label>
          </>
        )}
        {authState === AuthState.PASSWORD_INPUT && (
          <label>
            <span>Password</span>
            <input type="password" onChange={ev => setPassword(ev.target.value)} autoFocus />
          </label>
        )}
        <label>
          <button type="submit" disabled={!isPossiblePhoneNumber(phoneNumber || '') || loading}>{loading ? '...' : '→'}</button>
        </label>
      </form>
    </div>
  )
}

export default TelegramAuth
