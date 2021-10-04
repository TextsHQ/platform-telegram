import React, { FormEvent } from 'react'
import { isPossiblePhoneNumber } from 'react-phone-number-input'
import PhoneInput from 'react-phone-number-input/input'
import type { PlatformAPI, LoginCreds, LoginResult } from '@textshq/platform-sdk'

const TelegramAuth: React.FC<{
  api: PlatformAPI
  login: (creds?: LoginCreds) => Promise<LoginResult>
}> = ({ api, login }) => {
  const [loading, setLoading] = React.useState(false)
  const [authState, setAuthState] = React.useState('')
  const [phoneNumber, setPhoneNumber] = React.useState('+')
  const [code, setCode] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [firstName, setFirstName] = React.useState('')
  const [lastName, setLastName] = React.useState('')

  const onSubmit = async (ev?: FormEvent<HTMLFormElement>) => {
    ev?.preventDefault()
    setLoading(true)

    await login({ 
      custom: { 
        phoneNumber, 
        code, 
        password, 
        firstName, 
        lastName 
      }
    })

    setLoading(false)
  }

  React.useEffect(() => {
    api.onLoginEvent(data => {
      setAuthState(data)
      if (data === 'authorizationStateReady') onSubmit()
    })
  }, [api])

  return (
    <div className="auth telegram-auth">
      <form onSubmit={onSubmit}>
        {authState === 'authorizationStateWaitPhoneNumber' && (
          <label>
            <span>Phone Number</span>
            <PhoneInput onChange={setPhoneNumber} value={phoneNumber} autoFocus />
          </label>
        )}

        {authState === 'authorizationStateWaitCode' && (
          <>
            <div>Authentication code has been sent to {phoneNumber} (check your Telegram app)</div>
            <label>
              <span>Code</span>
              <input type="number" onChange={ev => setCode(ev.target.value)} value={code} autoFocus />
            </label>

            <label>
              <span>Password (if 2FA enabled)</span>
              <input type="password" onChange={ev => setPassword(ev.target.value)} />
            </label>
          </>
        )}

        {authState === 'authorizationSignUp' && (
          <>
            <div>It seems you don't have an account, please create one</div>
            <label>
              <span>First Name</span>
              <input type="text" onChange={ev => setFirstName(ev.target.value)} value={firstName} autoFocus />
            </label>

            <label>
              <span>Last Name</span>
              <input type="text" onChange={ev => setLastName(ev.target.value)} value={lastName} />
            </label>
          </>
        )}

        {/* TODO: Use this */}
        {/* {authState === 'authorizationStateWaitPassword' && (
          <>
            <label>
              <span>Code</span>
              <input type="number" onChange={ev => setPassword(ev.target.value)} value={code} autoFocus />
            </label>
          </>
        )} */}

        <label>
          <button type="submit" disabled={!isPossiblePhoneNumber(phoneNumber || '') || loading}>{loading ? '...' : '→'}</button>
        </label>
      </form>
    </div>
  )
}

export default TelegramAuth
