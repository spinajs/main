import { Connection, Primary,  Model, HasMany } from "../../../src/decorators";
import { ModelBase } from "../../../src/model";
import { Relation } from "../../../src/relations";
import { ModelNested2 } from "./ModelNested2";

@Connection("sqlite")
@Model("ModelNested1")
// @ts-ignore
export class ModelNested1 extends ModelBase
{
    @Primary()
    public Id: number;
 
    public Property1: string;

    @HasMany(ModelNested2, "rel_1")
    public HasMany1 : Relation<ModelNested2>;
}