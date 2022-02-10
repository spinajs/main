import { Connection, Primary,  Archived, CreatedAt, UpdatedAt, SoftDelete, Model } from "../../../src/decorators";
import { ModelBase } from "../../../src/model";

@Connection("SampleConnectionNotExists")
@Model("test_model")
// @ts-ignore
export class ModelNoConnection extends ModelBase
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