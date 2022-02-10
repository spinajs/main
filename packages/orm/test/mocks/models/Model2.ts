import { Connection, Primary,  Model, Archived, CreatedAt, UpdatedAt, SoftDelete } from "../../../src/decorators";
import { ModelBase } from "../../../src/model";

@Connection("SampleConnection1")
@Model("TestTable2")
// @ts-ignore
export class Model2 extends ModelBase
{
    @Primary()
    public Id: number;

    @Archived()
    public ArchivedAt : Date;

    @CreatedAt()
    public CreatedAt : Date;

    @UpdatedAt()
    public UpdatedAt : Date;

    @SoftDelete()
    public DeletedAt : Date;
}