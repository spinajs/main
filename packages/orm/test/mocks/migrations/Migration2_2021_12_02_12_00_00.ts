import { OrmMigration, Migration } from "../../../src";
import { OrmDriver } from "../../../src/driver";

@Migration("sqlite")
// @ts-ignore
export class Migration2 extends OrmMigration {

    // tslint:disable-next-line: no-empty
    public async up(_connection: OrmDriver): Promise<void> {

    }

    // tslint:disable-next-line: no-empty
    public async down(_connection: OrmDriver): Promise<void> {

    }
}