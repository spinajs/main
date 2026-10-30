import { AutoinjectService } from '@spinajs/configuration';
import { Autoinject, Injectable, LazyInject, Singleton } from '@spinajs/di';

export class Db {}
export class Plugin {}

type Plugins = Plugin[];
type ByName = Map<string, Plugin>;

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

  @Autoinject(Plugin)
  public alias: Plugins;

  @Autoinject(Plugin)
  public readonlyList: readonly Plugin[];

  @Autoinject(Plugin)
  public optionalAlias?: Plugins;

  @Autoinject(Plugin, { mapFunc: (x: Plugin) => x.constructor.name })
  public mapAlias: ByName;

  @LazyInject(Plugin)
  public lazyAlias: Plugins;

  @LazyInject(Plugin)
  public lazyReadonly: readonly Plugin[];
}

@Injectable()
export class Configured {
  @AutoinjectService('app.plugins', Plugin)
  public alias: Plugins;

  @AutoinjectService('app.plugins', Plugin)
  public readonlyList: readonly Plugin[];

  @AutoinjectService('app.plugin', Plugin)
  public one: Plugin;
}

export abstract class Base {
  @Autoinject()
  public db: Db;
}

export class Plain {
  public untouched: Db;
}
