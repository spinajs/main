export class MemoryStore {
  public list(): number[] {
    return [];
  }
}

export class TableStore {
  public list(): number[] {
    return [1];
  }
}

export function listOpen(): number[] {
  return [];
}

export function listAll(): number[] {
  return [1];
}

export class ChoiceShapes {
  public picked(cached: boolean) {
    const store = cached ? new MemoryStore() : new TableStore();
    return store.list();
  }

  public inline(cached: boolean) {
    return (cached ? new MemoryStore() : new TableStore()).list();
  }

  public typed(store: MemoryStore | TableStore) {
    return store.list();
  }

  public keyed(key: 'first' | 'second') {
    return this[key]();
  }

  public chosen(all: boolean) {
    const list = all ? listAll : listOpen;
    return list();
  }

  public first() {
    return 1;
  }

  public second() {
    return 2;
  }
}

export interface Lister {
  list(): number[];
}

export class BaseLister implements Lister {
  public list(): number[] {
    return [];
  }
}

export class LeafLister extends BaseLister {
  public override list(): number[] {
    return [1];
  }
}

export function viaBase(lister: Lister) {
  return lister.list();
}

export interface Counter {
  count(): number;
}

export abstract class CounterBase implements Counter {
  public count(): number {
    return 0;
  }
}

export class LeafCounter extends CounterBase {}

export function viaAbstractBase(counter: Counter) {
  return counter.count();
}

export interface Cursor {
  readonly position: number;
}

export class TableCursor implements Cursor {
  public get position() {
    return 1;
  }
}

export function readPosition(cursor: Cursor) {
  return cursor.position;
}

export abstract class Paged {
  public abstract readonly page: number;

  public next() {
    return this.page + 1;
  }
}

export class FirstPage extends Paged {
  public get page() {
    return 1;
  }
}

export function later(run?: () => void) {
  if (run) setTimeout(run, 0);
}

export function maybeLater(run?: () => void) {
  later(run);
}

export class Maker {
  public static make(): number {
    return 1;
  }

  public static run(): number {
    return this.make();
  }
}

export class SubMaker extends Maker {
  public static override make(): number {
    return 2;
  }
}

export class Narrow {
  public run(): number {
    return 1;
  }
}

export class Wide {
  public run(): number {
    return 2;
  }

  public extra(): number {
    return 3;
  }
}

export class Ctx {
  public svc = new Narrow();

  public run(): number {
    return 0;
  }
}

export class NarrowedShapes {
  public narrowed(wide: boolean) {
    const s = wide ? new Narrow() : new Wide();
    if (s instanceof Wide) return s.run();
    return 0;
  }

  public guarded(c: Ctx | undefined) {
    const s = c && c.svc;
    return s?.run();
  }
}
