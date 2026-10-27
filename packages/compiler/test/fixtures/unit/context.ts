export class Base {}
export class Mid extends Base {}
export class Leaf extends Mid {}
export const OBJ = { a: 1, b: ['x', 'y'], c: { d: true } };
export enum Kind { A = 'alpha', B = 'beta' }
export class Ok<T> { constructor(public data: T) {} }
export class Dto { id!: number }
export class Svc {
  one(): Promise<Ok<Dto>> { return Promise.resolve(new Ok(new Dto())); }
  two(): Dto[] { return []; }
  three(): Promise<void> { return Promise.resolve(); }
}
