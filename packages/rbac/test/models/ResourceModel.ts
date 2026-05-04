import { Connection, Model, ModelBase, Primary } from "@spinajs/orm";
import { OrmResource, ResourceOwner } from "../../src/decorators.js";

@Connection('default')
@Model('test')
@OrmResource("Test")
export class ResourceModel extends ModelBase {

    @Primary()
    public Id: number;

    @ResourceOwner()
    public UserId : number;

}