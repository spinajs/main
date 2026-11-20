import { Model, ModelBase, Primary } from '@spinajs/orm';

@Model('entries')
export class Entry extends ModelBase<Entry> {
  @Primary() public Id: number;
}
