import { Connection, Primary,  Model, HasManyToMany } from "../../../src/decorators";
import { ModelBase } from "../../../src/model";
import { Model5 } from "./Model5";
import { JunctionModel } from "./JunctionModel";
import { Relation } from "../../../src/relations";

@Connection("sqlite")
@Model("TestTable4")
// @ts-ignore
export class Model4 extends ModelBase
{
    @Primary()
    public Id: number;
 
    public Property4: string;

    @HasManyToMany(JunctionModel,Model5)
    public ManyOwners : Relation<Model5>;
}