import bigInt from 'big-integer'
import { isArrayLike } from 'lodash'
import { utils } from 'telegram'
import { Api } from 'telegram/tl'
import { AuthKey } from 'telegram/crypto/AuthKey'
import type { EntityLike } from 'telegram/define'
import { returnBigInt } from 'telegram/Helpers'
import { MemorySession } from 'telegram/sessions'
import { getDisplayName, getInputPeer, getPeerId } from 'telegram/Utils'
import { IAsyncSqlite, texts } from '@textshq/platform-sdk'
import { mkdir, stat } from 'fs/promises'
import { dirname } from 'path'
import { stringifyCircular } from './util'

const { IS_DEV } = texts
const AsyncSqlite = (globalThis as any).AsyncSqlite as IAsyncSqlite

interface EntityObject {
  id: string
  hash: string
  username?: string
  phone?: string
  name?: string
}

export class DbSession extends MemorySession {
  private sessionSchema = `
    CREATE TABLE version (version integer primary key);

    CREATE TABLE session (
        dc_id integer not null primary key,
        address text not null,
        port integer not null,
        auth blob not null
    );
    
    CREATE TABLE entity (
        id integer not null primary key,
        hash integer,
        username text,
        phone text,
        name text
    );`

  private db: IAsyncSqlite

  private dbPath: string

  private version = 1

  private _entityObjects: EntityObject[]

  constructor({ dbPath }: { dbPath: string }) {
    super()
    this.dbPath = dbPath
    this.db = new AsyncSqlite()
    this._entityObjects = []
  }

  private createTables = async () => {
    await this.db.exec(this.sessionSchema)
    await this.db.run('insert into version values (?)', [this.version])
  }

  async load() {
    try {
      await stat(dirname(this.dbPath))
    } catch {
      await mkdir(dirname(this.dbPath))
    }
    if (IS_DEV) console.log(`load DB path: ${this.dbPath}`)
    await this.db.init(this.dbPath, {})
    if (
      !(await this.db.get(
        'select name from sqlite_master where type=\'table\' and name=\'version\'',
      ))
    ) {
      await this.createTables()
      return
    }
    const session = await this.db.get('select * from session')
    if (!session) return
    this._dcId = session.dc_id
    this._serverAddress = session.serverAddress
    this._port = session.port
    this._authKey = new AuthKey()
    await this._authKey.setKey(session.auth)

    const entities = await this.db.raw_all('select * from entity')
    if (entities) {
      this._entityObjects = [
        entities.map(e => ({
          id: e.id,
          hash: e.hash,
          name: e.name,
          phone: e.phone,
          username: e.username,
        })),
      ]
    }
  }

  processEntities(tlo: any): any {
    let entities: any = []
    if (!(tlo.classType === 'constructor') && isArrayLike(tlo)) {
      // This may be a list of users already for instance
      entities = tlo
    } else if (typeof tlo === 'object') {
      if ('user' in tlo) {
        entities.push(tlo.user)
      }
      if ('chat' in tlo) {
        entities.push(tlo.chat)
      }
      if ('channel' in tlo) {
        entities.push(tlo.channel)
      }
      if ('chats' in tlo && isArrayLike(tlo.chats)) {
        entities = entities.concat(tlo.chats)
      }
      if ('users' in tlo && isArrayLike(tlo.users)) {
        entities = entities.concat(tlo.users)
      }
    }
    entities = entities.filter(
      (e: { className: string }) => e.className !== 'constructor',
    )
    for (const e of entities) {
      const entityObject = this.entityObject(e)
      if (entityObject) {
        this._entityObjects.push(entityObject)
      }
    }
  }

  private entityObject = (e: any): EntityObject => {
    try {
      const peer = getInputPeer(e, false)
      const peerId = getPeerId(peer)
      const hash = 'accessHash' in peer ? peer.accessHash : bigInt.zero
      const username = e.username?.toLowerCase()
      const { phone } = e
      const name = getDisplayName(e)
      return { id: peerId, hash: hash.toString(), username, phone, name }
    } catch {
      return null
    }
  }

  private getEntityByPhone = (phone: string) =>
    this._entityObjects.find(e => e.phone === phone)

  private getEntityByUsername = (username: string) =>
    this._entityObjects.find(e => e.username === username)

  private getEntityByName = (name: string) =>
    this._entityObjects.find(e => e.name === name)

  private getEntityById = (id: string, exact = true) => {
    if (exact) {
      return this._entityObjects.find(e => e.id === id)
    }
    const ids = [
      utils.getPeerId(new Api.PeerUser({ userId: returnBigInt(id) })),
      utils.getPeerId(new Api.PeerChat({ chatId: returnBigInt(id) })),
      utils.getPeerId(new Api.PeerChannel({ channelId: returnBigInt(id) })),
    ]
    return this._entityObjects.find(e => ids.includes(e.id))
  }

  getInputEntity(key: EntityLike): Api.TypeInputPeer {
    let entityKey = key
    if (IS_DEV) console.log(`getInputEntity: ${stringifyCircular(entityKey, 2)}`)
    let exact: boolean
    if (
      typeof entityKey === 'object'
      && !bigInt.isInstance(entityKey)
      && entityKey.SUBCLASS_OF_ID
    ) {
      if (
        // TypeInputPeer
        // TypeInputPeer
        // TypeInputChannel
        entityKey.SUBCLASS_OF_ID === 0xc91c90b6
        || entityKey.SUBCLASS_OF_ID === 0xe669bf46
        || entityKey.SUBCLASS_OF_ID === 0x40f202fd
      ) {
        // @ts-expect-error
        return entityKey
      }
      // Try to early return if this key can be casted as input peer
      return utils.getInputPeer(entityKey)
    }
    // Not a TLObject or can't be cast into InputPeer
    if (typeof entityKey === 'object') {
      entityKey = utils.getPeerId(entityKey)
      exact = true
    } else {
      exact = false
    }

    if (
      bigInt.isInstance(entityKey)
      || typeof entityKey === 'bigint'
      || typeof entityKey === 'number'
    ) {
      entityKey = entityKey.toString()
    }
    let result: EntityObject
    if (typeof entityKey === 'string') {
      const phone = utils.parsePhone(entityKey)
      if (phone) {
        result = this.getEntityByPhone(phone)
      } else {
        const { username, isInvite } = utils.parseUsername(entityKey)
        if (username && !isInvite) {
          result = this.getEntityByUsername(username)
        }
      }
      if (!result) {
        const id = utils.parseID(entityKey)
        if (id) {
          result = this.getEntityById(entityKey, exact)
        }
      }
      if (!result) {
        result = this.getEntityByName(entityKey)
      }
    }
    if (result) {
      const resolved = utils.resolveId(returnBigInt(result.id))
      const entityId = resolved[0]
      const kind = resolved[1]
      const accessHash = returnBigInt(result.hash)
      // removes the mark and returns type of entity
      if (kind === Api.PeerUser) {
        return new Api.InputPeerUser({
          userId: entityId,
          accessHash,
        })
      } if (kind === Api.PeerChat) {
        return new Api.InputPeerChat({ chatId: entityId })
      } if (kind === Api.PeerChannel) {
        return new Api.InputPeerChannel({
          channelId: entityId,
          accessHash,
        })
      }
    } else {
      throw new Error('Could not find input entity with key ' + entityKey)
    }
    throw new Error('Could not find input entity with key ' + entityKey)
  }

  close() {
    this.db.dispose()
  }

  save() {
    this.db.run('insert or replace into session values (?,?,?,?)', [
      this.dcId,
      this.serverAddress,
      this.port,
      this.authKey.getKey(),
    ])
    const set = new Set(this._entityObjects)
    for (const e of set) {
      this.db.run('insert or replace into entity values (?, ?, ?, ?, ?)', [
        e.id,
        e.hash,
        e.username,
        e.phone,
        e.name,
      ])
    }
  }
}