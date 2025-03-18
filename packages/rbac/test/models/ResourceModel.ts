import { Connection, Model, ModelBase } from "@spinajs/orm";
import { OrmResource, ResourceOwner } from "../../src/decorators.js";

@Connection('default')
@Model('test')
@OrmResource("Test")
export class ResourceModel extends ModelBase {
  

    @ResourceOwner()
    public UserId : number;

}