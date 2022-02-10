import { Connection, Primary, Model, BelongsTo } from "../../../src/decorators";
import { ModelBase } from "../../../src/model";
import { RelationModel2 } from "./RelationModel2";

@Connection("sqlite")
@Model("TestTableRelation1")
// @ts-ignore
export class RelationModel1 extends ModelBase
{
    @Primary()
    public Id: number;

    @BelongsTo("OwnerId", "Id")
    public Owner : RelationModel2;

    public Property1: string;
}
