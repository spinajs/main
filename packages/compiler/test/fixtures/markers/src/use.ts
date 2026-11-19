import { ROOT as R, Service, Sub, type Base, type Composed, type Fixed, type Fixed2, type IUpdMore, type Sub2 } from './index.js';

export const aliased = R;
export const service = new Service();
export const sub = new Sub(1);
export declare const more: IUpdMore<string>;
export declare const base: Base<number>;
export declare const sub2: Sub2<boolean>;
export declare const fixed: Fixed;
export declare const fixed2: Fixed2;
export declare const composed: Composed<number>;
