
import { Configuration } from "@spinajs/configuration";
import { SqliteOrmDriver } from "../src/index";
import { DI } from "@spinajs/di";
import { SpinaJsDefaultLog, LogModule } from "@spinajs/log";
import { Orm, MigrationTransactionMode, QueryContext, OrmMigration, OrmDriver, Migration } from "@spinajs/orm";
import * as _ from "lodash";
import * as chai from 'chai';
import sinon from 'sinon';
import { ConnectionConf, dir, TEST_MIGRATION_TABLE_NAME, db } from './sqlite.test';

export class ConnectionConfTransaction extends ConnectionConf {

    protected conf = {
        system: {
            dirs: {
                models: [dir("./models")],
                migrations: [dir("./migrations")]
            }
        },
        db: {
            Migration:{
                Startup: false,
            },
            Connections: [
                {
                    Driver: "orm-driver-sqlite",
                    Filename: ":memory:",
                    Name: "sqlite",
                    Migration: {
                        Table: TEST_MIGRATION_TABLE_NAME,

                        Transaction: {
                            Mode: MigrationTransactionMode.PerMigration
                        }
                    }
                }
            ]
        }
    }
}

const expect = chai.expect;
describe("Sqlite driver migrate with transaction", () => {

    const sandbox = sinon.createSandbox();

    beforeEach(async () => {
        DI.register(ConnectionConfTransaction).as(Configuration);
        DI.register(SqliteOrmDriver).as("orm-driver-sqlite");
        DI.register(SpinaJsDefaultLog).as(LogModule);

        DI.resolve(LogModule);
        await DI.resolve(Orm);

        const driver = await DI.resolve<SqliteOrmDriver>("orm-driver-sqlite");
        sandbox.spy(driver, "transaction");
        sandbox.spy(driver, "execute");
    });

    afterEach(() => {
        sandbox.restore();
        DI.clear();
    });

    it("Should commit migration", async () => {
        const driver = await DI.resolve<SqliteOrmDriver>("orm-driver-sqlite");
        await db().migrateUp();

        expect((driver.transaction as any).calledOnce).to.be.true;
        expect((driver.execute as any).getCall(4).args[0]).to.eq("BEGIN TRANSACTION");
        expect((driver.execute as any).getCall(8).args[0]).to.eq("COMMIT");

        expect(driver.execute("SELECT * FROM user", null, QueryContext.Select)).to.be.fulfilled;

        const result = await driver.execute(`SELECT * FROM ${TEST_MIGRATION_TABLE_NAME}`, null, QueryContext.Select);
        expect(result[0]).to.be.not.undefined;
        expect(result[0]).to.be.not.null;
        expect(result[0].Migration).to.eq("TestMigration");

    });

    it("Should rollback migration", async () => {


        @Migration("sqlite")
        // @ts-ignore
        class MigrationFailed extends OrmMigration {
            public async up(connection: OrmDriver): Promise<void> {
                await connection.insert().into("not_exists").values({ id: 1 });
            }
            public down(_connection: OrmDriver): Promise<void> {
                return;
            }
        }

        class Fake2Orm extends Orm {
            constructor() {
                super();

                this.Migrations.length = 0;
                this.Models.length = 0;
                this.registerMigration(MigrationFailed);
            }
        }
        const container = DI.child();
        container.register(Fake2Orm).as(Orm);
        const orm = await container.resolve(Orm);
        await orm.migrateUp();

        const driver = await DI.resolve<SqliteOrmDriver>("orm-driver-sqlite");

        expect((driver.transaction as any).calledOnce).to.be.true;
        expect((driver.execute as any).getCall(4).args[0]).to.eq("BEGIN TRANSACTION");
        expect((driver.execute as any).getCall(6).args[0]).to.eq("ROLLBACK");

        expect(driver.execute("SELECT * FROM user", null, QueryContext.Select)).to.be.rejected;
        const result = await driver.execute(`SELECT * FROM ${TEST_MIGRATION_TABLE_NAME}`, null, QueryContext.Select);
        expect(result.length).to.be.eq(0);
    });

});
