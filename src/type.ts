import { Api } from "telegram/tl";

export type WithEntities<T> = T & {
  _entities: (Api.TypeUser | Api.TypeChat)[];
}