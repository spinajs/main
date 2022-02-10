import { IWhereBuilder } from './interfaces';

export type WhereFunction = (this: IWhereBuilder) => IWhereBuilder;
