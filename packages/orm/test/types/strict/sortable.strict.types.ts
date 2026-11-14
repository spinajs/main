import { ModelBase, Sortable } from '@spinajs/orm';
import type { Relation } from '@spinajs/orm';
import type { UserMetadata } from '../models.js';

export class SortableModel extends ModelBase<SortableModel> {
  @Sortable()
  public Id: number;

  @Sortable()
  public Email: string;

  // @ts-expect-error a relation is not a column
  @Sortable()
  public Metadata: Relation<UserMetadata, SortableModel>;

  public describe(): string {
    return this.Email;
  }
}

export class SortableMethod extends ModelBase<SortableMethod> {
  public Id: number;

  // @ts-expect-error a method is not a column
  @Sortable()
  public describe(): string {
    return '';
  }
}
