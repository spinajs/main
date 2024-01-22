import { ModelBase, Primary, Connection, Model, HasMany, Relation, BelongsTo, SingleRelation } from '@spinajs/orm';

@Connection('sqlite')
@Model('SetItem')
export class SetItem extends ModelBase {
    @Primary()
    public Id: number;

    public Val: number;

    @BelongsTo("DataSet")
    public SetData: SingleRelation<DataSet>;
}

@Connection('sqlite')
@Model('SetData')
export class DataSet extends ModelBase {
    @Primary()
    public Id: number;

    @HasMany(SetItem)
    Dataset: Relation<SetItem, DataSet>;
}
