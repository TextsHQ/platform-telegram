import { Api } from 'telegram/tl'

export type WithEntities<T> = T & {
  _entities: Map<string, Api.TypeUser | Api.TypeChat>
}
