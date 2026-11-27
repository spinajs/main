// Application types named like the wrappers, which are the global `Promise` and the orm's `ModelData` aliases.
export class Promise<T> { constructor(public value: T) {} }
export type ModelData<T> = { data: T };
export type ModelDataWithRelationData<T> = { data: T; related?: T };
