// db version of https://github.com/gram-js/gramjs/blob/master/gramjs/sessions/Memory.ts
import { promises as fsp } from 'fs'
import path from 'path'
import bigInt from 'big-integer'
import { isArrayLike } from 'lodash'
import Database, { Statement } from 'better-sqlite3'
import { texts } from '@textshq/platform-sdk'

import { utils } from 'telegram'
import { Api } from 'telegram/tl'
import { returnBigInt } from 'telegram/Helpers'
import { Session } from 'telegram/sessions'
import { BinaryReader } from 'telegram/extensions/BinaryReader'
import { getDisplayName, getPeerId } from 'telegram/Utils'
import { AuthKey } from 'telegram/crypto/AuthKey'
import type { EntityLike } from 'telegram/define'

interface EntityObject {
  id: string
  hash: string
  username?: string
  phone?: string
  name?: string
}

const SCHEMA_MIGRATIONS = [
  `PRAGMA journal_mode=wal;

  CREATE TABLE IF NOT EXISTS session (
    dc_id INTEGER NOT NULL PRIMARY KEY,
    address TEXT,
    port INTEGER,
    auth BLOB
  );

  CREATE TABLE IF NOT EXISTS entity (
    id TEXT NOT NULL PRIMARY KEY,
    hash TEXT,
    username TEXT,
    phone TEXT,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS cache (
    key TEXT NOT NULL PRIMARY KEY,
    hash TEXT,
    value BLOB NOT NULL,
    created_timestamp INTEGER NOT NULL
  );

  DROP TABLE IF EXISTS version;
  CREATE INDEX IF NOT EXISTS entity_idx_username ON entity (username);
  CREATE INDEX IF NOT EXISTS entity_idx_phone ON entity (phone);
  CREATE INDEX IF NOT EXISTS entity_idx_name ON entity (name);`,
]

export class DbSession extends Session {
  private db: Database.Database

  private readonly statementCache = new Map<string, Statement>()

  protected _dcId = 0

  protected _serverAddress?: string

  protected _port?: number

  protected _takeoutId: undefined

  protected _authKey?: AuthKey

  private _key?: Buffer

  readonly initPromise: Promise<void>

  private async updateSchema() {
    // this should be 0 when new
    const currentSchemaVersion: number = this.db.prepare('PRAGMA user_version').pluck().get()
    let i = currentSchemaVersion
    for (const schemaMigration of SCHEMA_MIGRATIONS.slice(currentSchemaVersion)) {
      texts.log('tg', { currentSchemaVersion, schemaMigration })
      this.db.exec(schemaMigration)
      this.db.exec(`PRAGMA user_version = ${++i}`)
    }
  }

  constructor(private readonly dbPath: string) {
    super()
    this.initPromise = this.init()
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
    this.save()
  }

  close(): void {
    this.db.close()
  }

  async save() {
    if (this.authKey?.getKey() && this.serverAddress && this.port) {
      this.prepareCache('insert or replace into session (dc_id, address, port, auth) values (?,?,?,?)')
        .run(this.dcId, this.serverAddress, this.port, this.authKey.getKey())
    }
  }

  delete(): void {
    // do nothing since only called on logout() and the entire directory is deleted
  }

  setDC(dcId: number, serverAddress: string, port: number) {
    this._dcId = dcId | 0
    this._serverAddress = serverAddress
    this._port = port
  }

  private async init() {
    await fsp.mkdir(path.dirname(this.dbPath), { recursive: true })
    this.db = new Database(this.dbPath, {})
    texts.log('tg', this.dbPath)
    this.updateSchema()
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
      const entityObject = this.entityObject(e)
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
      return undefined
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
      getPeerId(new Api.PeerUser({ userId: returnBigInt(id) })),
      getPeerId(new Api.PeerChat({ chatId: returnBigInt(id) })),
      getPeerId(new Api.PeerChannel({ channelId: returnBigInt(id) })),
    ]
    return this.prepareCache('select * from entity where id IN (?)').get(ids)
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
        // https://github.com/gram-js/gramjs/blob/6f7568c8ff38a7491d2ed6d1563205b691a9b56e/gramjs/sessions/Memory.ts#L239-L241
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
      entityKey = getPeerId(entityKey)
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
    let result: any
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
      switch (kind) {
        case Api.PeerUser:
          return new Api.InputPeerUser({
            userId: entityId,
            accessHash,
          })
        case Api.PeerChat:
          return new Api.InputPeerChat({ chatId: entityId })
        case Api.PeerChannel:
          return new Api.InputPeerChannel({
            channelId: entityId,
            accessHash,
          })
        default:
          break
      }
    }
    throw new Error('Could not find input entity with key ' + entityKey)
  }

  cacheGetHash(key: string): string {
    const hash = this.prepareCache('select hash from cache where key = ?').pluck().get(key)
    return hash
  }

  cacheGetValue<T>(key: string) {
    const value = this.prepareCache('select value from cache where key = ?').pluck().get(key)
    if (value) return new BinaryReader(value).tgReadObject() as T
  }

  cacheSet<T>(key: string, hash: number | bigInt.BigInteger, value: T) {
    this.prepareCache('insert or replace into cache values (?,?,?,?)').run(key, String(hash), value, Date.now())
  }
}
