import path from 'path'
import { BINARIES_DIR_PATH } from './constants'

function addToPath(dirPath: string) {
  /*
    https://docs.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order
    https://github.com/atom/atom/issues/11302
    https://github.com/node-ffi/node-ffi/issues/288#issuecomment-359801707
  */
  process.env.PATH += path.delimiter + dirPath
  process.env.Path += path.delimiter + dirPath
}

const IS_WINDOWS = process.platform === 'win32'

if (IS_WINDOWS) {
  addToPath(BINARIES_DIR_PATH)
}
