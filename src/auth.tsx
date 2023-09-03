import { useState, useEffect, FormEvent } from 'react'
import { isPossiblePhoneNumber } from 'react-phone-number-input'
import PhoneInput from 'react-phone-number-input/input'
import QRCode from '@textshq/platform-sdk/dist/QRCode'
import type { AuthProps } from '@textshq/platform-sdk'

import { AuthState } from './common-constants'

const instructions = (
  <div className="list">
    <div><span>1</span>Open the Telegram app on your phone</div>
    <div><span>2</span>Go to Settings → Devices</div>
    <div><span>3</span>Tap "Link Desktop Device"</div>
    <div><span>4</span>Scan the QR code with your phone</div>
  </div>
)

const TelegramAuth: React.FC<AuthProps> = ({ api, login, meContact }) => {
  const [loading, setLoading] = useState(false)
  const [authState, setAuthState] = useState(AuthState.PHONE_INPUT)
  const [phoneNumber, setPhoneNumber] = useState(meContact?.phoneNumbers?.[0] || '+')
  const [qrLink, setQRLink] = useState<string>()
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const _login = async (custom: any) => {
    setLoading(true)
    try {
      await login({ custom })
    } finally {
      setLoading(false)
    }
  }
  const onSubmit = async (ev?: FormEvent<HTMLFormElement>) => {
    ev?.preventDefault()
    _login({ phoneNumber, code, password })
  }
  const onPaste = (ev: React.ClipboardEvent<HTMLInputElement>) => {
    const codeTxt = ev.clipboardData.getData('text').trim()
    if (/^\d+$/.test(codeTxt)) { // auto submit when pasted code is numeric
      ev.preventDefault()
      setCode(codeTxt)
      _login({ phoneNumber, code: codeTxt, password })
    }
  }
  useEffect(() => {
    api.onLoginEvent(({ authState: state, qrLink: qrLinkValue }: { authState: AuthState, qrLink?: string }) => {
      setAuthState(state)
      setQRLink(qrLinkValue)
      if (state === AuthState.READY) onSubmit()
    })
  }, [api])
  const onQRLoginClick = () => {
    setAuthState(AuthState.QR_CODE)
    login({ custom: 'qr' })
  }
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
            <div>Authentication code has been sent to the Telegram app on your phone ({phoneNumber})</div>
            <label>
              <span>Code</span>
              <input type="number" autoComplete="one-time-code" pattern="[0-9]*" onPaste={onPaste} onChange={ev => setCode(ev.target.value)} value={code} autoFocus />
            </label>
          </>
        )}
        {authState === AuthState.PASSWORD_INPUT && (
          <label>
            <span>Password</span>
            <input type="password" autoComplete="current-password" onChange={ev => setPassword(ev.target.value)} autoFocus />
          </label>
        )}
        {authState === AuthState.QR_CODE
          ? <>
              {instructions}
              {qrLink ? <QRCode value={qrLink} /> : 'Loading...'}
            </>
          : (
            <label>
              <button type="submit" disabled={!isPossiblePhoneNumber(phoneNumber || '') || loading}>{loading ? '...' : '→'}</button>
            </label>
          )}
        {authState === AuthState.PHONE_INPUT && (
          <label style={{ borderTop: '1px solid rgba(0,0,0,.1)', marginTop: '2em', paddingTop: '2em' }}>
            <button type="button" onClick={onQRLoginClick}>Login with QR code instead</button>
          </label>
        )}
      </form>
    </div>
  )
}

export default TelegramAuth
