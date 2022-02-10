import { Connection, Primary,  Model, Archived, CreatedAt, UpdatedAt, SoftDelete, BelongsTo, DateTime } from "../../../src/decorators";
import { ModelBase } from "../../../src/model";
import { Model4 } from "./Model4";

@Connection("sqlite")
@Model("TestTable1")
// @ts-ignore
export class Model1 extends ModelBase
{
    @Primary()
    public Id: number;

    @Archived()
    @DateTime()
    public ArchivedAt : Date;

    @CreatedAt()
    public CreatedAt : Date;

    @UpdatedAt()
    public UpdatedAt : Date;

    @SoftDelete()
    public DeletedAt : Date;

    public Bar : string;

    @BelongsTo("OwnerId")
    public Owner : Model4;
}
