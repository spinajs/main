import { ModelBase, Primary, CreatedAt, Connection, Model } from "@spinajs/orm";
 

@Connection("sqlite")
@Model("user")
export class User extends ModelBase<User>
{
    @Primary()
    public Id: number;

    public Name: string;

    public Password: string;

    @CreatedAt()
    public CreatedAt: Date;
}