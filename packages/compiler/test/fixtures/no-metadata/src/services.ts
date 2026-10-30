import { Autoinject, LazyInject, Singleton } from '@spinajs/di';

export class Db {}
export class Plugin {}

@Singleton()
export class Repo {
  @Autoinject()
  public db: Db;

  @LazyInject()
  public lazy: Db;

  @Autoinject(Plugin)
  public one: Plugin;

  @Autoinject(Plugin)
  public list: Plugin[];

  @Autoinject(Plugin, { mapFunc: (x: Plugin) => x.constructor.name })
  public map: Map<string, Plugin>;
}

export abstract class Base {
  @Autoinject()
  public db: Db;
}

export class Plain {
  public untouched: Db;
}
