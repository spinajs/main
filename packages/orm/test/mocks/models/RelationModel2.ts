import { Connection, Primary, Model, BelongsTo, HasMany } from "../../../src/decorators";
import { ModelBase } from "../../../src/model";
import { Model1 } from "./Model1";
import { Relation } from "../../../src/relations";


@Connection("sqlite")
@Model("TestTableRelation2")
// @ts-ignore
export class RelationModel2 extends ModelBase
{
    @Primary()
    public Id: number;
    
    @BelongsTo("OwnerId", "Id")
    public Owner : Model1;

    public Property2: string;

    @HasMany(Model1, "RelId2")
    public Many : Relation<Model1>;
}
