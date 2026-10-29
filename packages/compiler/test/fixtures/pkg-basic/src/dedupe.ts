import { DI, Injectable } from '@spinajs/di';

@Injectable()
export class Dual {}

DI.register(Dual).as('DualAlias');
