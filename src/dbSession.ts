import bigInt from 'big-integer'
import { isArrayLike } from 'lodash'
import { utils } from 'telegram'
import { Api } from 'telegram/tl'
import type { EntityLike } from 'telegram/define'
import { returnBigInt } from 'telegram/Helpers'
import { Session } from 'telegram/sessions'
import { getDisplayName, getPeerId } from 'telegram/Utils'
import { texts } from '@textshq/platform-sdk'
import { mkdir, stat } from 'fs/promises'
import { dirname } from 'path'
// eslint-disable-next-line import/no-extraneous-dependencies
import Database, { Statement } from 'better-sqlite3'
import { AuthKey } from 'telegram/crypto/AuthKey'

interface EntityObject {
  id: string
  hash: string
  username?: string
  phone?: string
  name?: string
}

export class DbSession extends Session {
  private sessionSchema = `
    CREATE TABLE version (version integer primary key);

    CREATE TABLE session (
        dc_id integer not null primary key,
        address text,
        port integer,
        auth blob
    );
    
    CREATE TABLE entity (
        id text not null primary key,
        hash text,
        username text,
        phone text,
        name text
    );`

  private db: Database.Database

  private dbPath: string

  private statementCache: Map<string, Statement>

  private version = 1

  protected _serverAddress?: string

  protected _dcId: number

  protected _port?: number

  protected _takeoutId: undefined

  protected _authKey?: AuthKey

  private _key?: Buffer

  constructor({ dbPath }: { dbPath: string }) {
    super()
    this._serverAddress = undefined
    this._dcId = 0
    this._port = undefined
    this._takeoutId = undefined
    this.dbPath = dbPath
    this.statementCache = new Map<string, Statement>()
  }

  private prepareCache = (sql: string): Statement => {
    if (!this.statementCache.has(sql)) {
      this.statementCache.set(sql, this.db.prepare(sql))
    }
    return this.statementCache.get(sql)
  }

  get dcId() {
    return this._dcId
  }

  get serverAddress() {
    return this._serverAddress!
  }

  get port() {
    return this._port!
  }

  get authKey() {
    return this._authKey
  }

  set authKey(value) {
    this._authKey = value
  }

  get takeoutId() {
    return this._takeoutId
  }

  set takeoutId(value) {
    this._takeoutId = value
  }

  getAuthKey(dcId?: number) {
    if (dcId && dcId !== this.dcId) {
      // Not supported.
      return undefined
    }

    return this.authKey
  }

  setAuthKey(authKey?: AuthKey, dcId?: number) {
    if (dcId && dcId !== this.dcId) {
      // Not supported.
      return undefined
    }

    this.authKey = authKey
  }

  close(): void {
    this.db.close()
  }

  save() {
    this.prepareCache('delete from session').run()
    if (this.authKey?.getKey() && this.serverAddress && this.port) {
      this.prepareCache('insert into session (dc_id, address, port, auth) values (?,?,?,?)')
        .run(this.dcId, this.serverAddress, this.port, this.authKey.getKey())
    }
  }

  // eslint-disable-next-line class-methods-use-this
  delete(): void {}

  setDC(dcId: number, serverAddress: string, port: number) {
    this._dcId = dcId | 0
    this._serverAddress = serverAddress
    this._port = port
  }

  private createTables = async () => {
    this.db.exec(this.sessionSchema)
    this.prepareCache('insert into version values (?)').run(this.version)
  }

  async init() {
    try {
      await stat(dirname(this.dbPath))
    } catch {
      await mkdir(dirname(this.dbPath))
    }
    this.db = new Database(this.dbPath, {})
    texts.log(`load DB path: ${this.dbPath}`)
    if (
      !(this.prepareCache(
        'select name from sqlite_master where type = ? and name = ?',
      ).get('table', 'version'))
    ) {
      await this.createTables()
    }
    const session = await this.prepareCache('select * from session').get()
    if (!session) return
    this._dcId = session.dc_id
    this._serverAddress = session.address
    this._port = session.port
    if (session.auth) this._key = session.auth
  }

  async load() {
    if (this._key) {
      this._authKey = new AuthKey()
      await this._authKey.setKey(this._key)
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
    entities = entities.filter((e: { className: string }) => e.className !== 'constructor')

    const stmt = this.prepareCache('insert or replace into entity (id, hash, username, phone, name) VALUES (?,?,?,?,?)')
    for (const e of entities) {
      const entityObject: EntityObject = this.entityObject(e)
      if (entityObject) {
        stmt.run(entityObject.id, entityObject.hash, entityObject.username, entityObject.phone, entityObject.name)
      }
    }
  }

  private entityObject = (e: any): EntityObject => {
    try {
      const peer = this.getInputEntity(e)
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

  private getEntityByPhone = (phone: string) => this.prepareCache('select * from entity where phone = ?').get(phone)

  private getEntityByUsername = (username: string) => this.prepareCache('select * from entity where username = ?').get(username)

  private getEntityByName = (name: string) => this.prepareCache('select * from entity where name = ?').get(name)

  private getEntityById = (id: string, exact = true) => {
    if (exact) {
      return this.prepareCache('select * from entity where id = ?').get(id)
    }
    const ids = [
      utils.getPeerId(new Api.PeerUser({ userId: returnBigInt(id) })),
      utils.getPeerId(new Api.PeerChat({ chatId: returnBigInt(id) })),
      utils.getPeerId(new Api.PeerChannel({ channelId: returnBigInt(id) })),
    ]
    return this.prepareCache('select * from entity where id IN(?)').get(ids)
  }

  getInputEntity(key: EntityLike): Api.TypeInputPeer {
    let entityKey = key
    // if (IS_DEV) console.log(`getInputEntity: ${stringifyCircular(entityKey, 2).substring(0, 20)}`)
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
    let result
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
}
