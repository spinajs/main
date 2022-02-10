import { Connection, Primary, Model } from "../../../src/decorators";
import { ModelBase } from "../../../src/model";

@Connection("sqlite")
@Model("TestTable3")
// @ts-ignore
export class Model3 extends ModelBase
{
    @Primary()
    public Id: number;

    public Foo: Map<string, string>;

    constructor(data?: any) {
        super(data);

        if (!this.Foo) {
            this.Foo = new Map();
        }
    }
}
