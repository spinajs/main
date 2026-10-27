import type { ModelBase, Relation } from '@spinajs/orm';
import type { Book } from './models.js';

/** Stands in for a model read from a dependency: declaration files carry no decorators. */
export declare class Shelf extends ModelBase<Shelf> {
  Id: number;
  /** `@Hidden()` in the package that owns the model; the decorator is gone here. */
  Password: string;
  Books: Relation<Book, Shelf>;
}
