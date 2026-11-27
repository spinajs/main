export class Base {}
export class Mid extends Base {}
export class Leaf extends Mid {}
export const OBJ = { a: 1, b: ['x', 'y'], c: { d: true } };
export enum Kind { A = 'alpha', B = 'beta' }
import { Ok } from '@spinajs/http';
export class Dto { id!: number }
export class Svc {
  one(): Promise<Ok<Dto>> { return Promise.resolve(new Ok(new Dto())); }
  two(): Dto[] { return []; }
  three(): Promise<void> { return Promise.resolve(); }
}
export class Created<T> { constructor(public data: T) {} }
export class Lookalike {
  made(): Created<Dto> { return new Created(new Dto()); }
}
