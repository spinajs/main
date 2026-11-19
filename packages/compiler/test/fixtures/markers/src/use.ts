import { ROOT as R, Service, Sub, type IUpdMore } from './index.js';

export const aliased = R;
export const service = new Service();
export const sub = new Sub(1);
export declare const more: IUpdMore<string>;
