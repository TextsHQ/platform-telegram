import { MessageDeletionMode, PlatformInfo, Attribute, texts } from '@textshq/platform-sdk'

const info: PlatformInfo = {
  name: 'telegram',
  version: '1.0.0',
  displayName: 'Telegram',
  icon: `<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="16" height="16" rx="5" fill="#179CDE"/>
<path d="M6.13735 12.1673C5.80961 12.1673 5.86533 12.0436 5.75229 11.7315L4.78862 8.56005L12.2067 4.15921" fill="#C8DAEA"/>
<path d="M6.13736 12.1673C6.39025 12.1673 6.50194 12.0517 6.64313 11.9144L7.99187 10.603L6.30949 9.58847" fill="#A9C9DD"/>
<path d="M6.30932 9.5887L10.3859 12.6005C10.8511 12.8572 11.1868 12.7243 11.3027 12.1687L12.962 4.34911C13.1319 3.668 12.7024 3.35897 12.2573 3.56103L2.51356 7.31818C1.84846 7.58498 1.85243 7.95605 2.39234 8.12136L4.89281 8.90185L10.6817 5.24973C10.955 5.08401 11.2058 5.17302 11 5.35578" fill="url(#paint0_linear)"/>
<defs>
<linearGradient id="paint0_linear" x1="9.26" y1="7.53184" x2="10.8387" y2="11.1287" gradientUnits="userSpaceOnUse">
<stop stop-color="#EFF7FC"/>
<stop offset="1" stop-color="white"/>
</linearGradient>
</defs>
</svg>`,
  loginMode: 'custom',
  auth: texts.React?.lazy(() => import('./auth')),
  deletionMode: MessageDeletionMode.DELETE_FOR_EVERYONE,
  attributes: new Set([
    Attribute.CAN_MESSAGE_USERNAME,
    Attribute.SUPPORTS_QUOTED_MESSAGES,
  ]),
}

export default info
