import path from 'path'
import { promises as fs } from 'fs'
import { fileExists } from './util'
import { BINARIES_DIR_PATH } from './constants'

const WIN_BINARIES_DIR_PATH = path.join(BINARIES_DIR_PATH, `${process.platform}-${process.arch}`)

async function copyFileFromBinaries(dirPath: string, fileName: string) {
  const newFilePath = path.join(dirPath, fileName)
  const exists = await fileExists(newFilePath)
  if (!exists) {
    await fs.copyFile(path.join(WIN_BINARIES_DIR_PATH, fileName), newFilePath)
  }
}

function addToPath(dirPath: string) {
  /*
    https://docs.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order
    https://github.com/atom/atom/issues/11302
    https://github.com/node-ffi/node-ffi/issues/288#issuecomment-359801707
    this is untested
  */
  process.env.PATH += path.delimiter + dirPath
  process.env.Path += path.delimiter + dirPath
}

export async function copyDLLsForWindows() {
  // once addToPath works, the following won't be needed
  const cwd = process.cwd()
  // if the app was started by windows autorun, this would be thrown
  // Error: EPERM: operation not permitted, copyfile 'C:\Users\$user\AppData\Local\Programs\jack\resources\app\build\platform-telegram\zlib1.dll' -> 'C:\Windows\System32\zlib1.dll']
  if (cwd.toLowerCase().includes(':\\windows\\system32')) return
  const promises = ['libcrypto-1_1-x64.dll', 'libssl-1_1-x64.dll', 'zlib1.dll'].map(fileName => copyFileFromBinaries(cwd, fileName))
  return Promise.all(promises)
}

export const IS_WINDOWS = process.platform === 'win32'

if (IS_WINDOWS) {
  addToPath(WIN_BINARIES_DIR_PATH)
}
