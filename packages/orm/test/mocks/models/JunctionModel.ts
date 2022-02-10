import { Connection, Primary,  Model } from "../../../src/decorators";
import { ModelBase } from "../../../src/model";
import { Model4 } from "./Model4";
import { Model5 } from "./Model5";

@Connection("sqlite")
@Model("JunctionTable")
// @ts-ignore
export class JunctionModel extends ModelBase
{
    @Primary()
    public Id: number;
 
    public OwnerModel: Model4;

    public ForeignModel: Model5;

    public JoinProperty: string;
}