import { TestMigration } from './migrations/TestMigration';
import { Configuration } from "@spinajs/configuration";
import { join, normalize, resolve } from 'path';
import { SqliteOrmDriver } from "./../src/index";
import { DI, IContainer } from "@spinajs/di";
import { SpinaJsDefaultLog, LogModule } from "@spinajs/log";
import { Orm, IWhereBuilder } from "@spinajs/orm";
import * as _ from "lodash";
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { User } from "./models/User";
import sinon from 'sinon';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
    return resolve(normalize(join(__dirname, path)));
}

export const TEST_MIGRATION_TABLE_NAME = "orm_migrations";

export class ConnectionConf extends Configuration {

    protected conf = {
        system: {
            dirs: {
                models: [dir("./models")],
                migrations: [dir("./migrations")]
            }
        },
        db: {
            Connections: [
                {
                    Driver: "orm-driver-sqlite",
                    Filename: ":memory:",
                    Name: "sqlite",
                    Migration: {
                        Table: TEST_MIGRATION_TABLE_NAME
                    }
                }
            ]
        }
    }

    // tslint:disable-next-line: no-empty
    public resolve(_container: IContainer) {

    }

    public get(path: string[], defaultValue?: any): any {
        return _.get(this.conf, path, defaultValue);
    }
}



export function db() {
    return DI.get(Orm);
}

describe("Sqlite driver migration, updates, deletions & inserts", () => {

    beforeEach(async () => {
        DI.register(ConnectionConf).as(Configuration);
        DI.register(SqliteOrmDriver).as("orm-driver-sqlite");
        DI.register(SpinaJsDefaultLog).as(LogModule);

        DI.resolve(LogModule);
        await DI.resolve(Orm);
    });

    afterEach(async () => {
        DI.clear();
    });

    it("Should migrate", async () => {

        await db().migrateUp();

        await db().Connections.get("sqlite").select().from("user");
        await expect(db().Connections.get("sqlite").select().from("notexisted")).to.be.rejected;


    })

    it("should insert query", async () => {

        await db().migrateUp();
        const id = await db().Connections.get("sqlite").insert().into("user").values({
            Name: "test",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });

        const result = await db().Connections.get("sqlite").select().from("user").first();

        expect(id).to.eq(1);
        expect(result).to.be.not.null;
        expect((result as any).Id).to.eq(1);
        expect((result as any).Name).to.eq("test");
    });

    it("should insert or ignore  query", async () => {

        const result = db().Connections.get("sqlite").insert().into("user").values({
            Name: "test",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        }).ignore().toDB();

         
        expect(result.expression).to.eq("INSERT OR IGNORE INTO `user` (`Name`,`Password`,`CreatedAt`) VALUES (?,?,?)");
       
    });

    it("should delete", async () => {
        await db().migrateUp();
        await db().Connections.get("sqlite").insert().into("user").values({
            Name: "test",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });

        await db().Connections.get("sqlite").del().from("user").where("id", 1);

        const result = await db().Connections.get("sqlite").select().from("user").first();
        expect(result).to.be.undefined;
    });

    it("should update", async () => {
        await db().migrateUp();
        await db().Connections.get("sqlite").insert().into("user").values({
            Name: "test",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });

        await db().Connections.get("sqlite").update().in("user").update({
            Name: "test updated"
        }).where("id", 1);

        const result = await db().Connections.get("sqlite").select().from("user").first();
        expect(result).to.be.not.null;
        expect((result as any).Name).to.eq("test updated");
    });

});



describe("Sqlite driver migrate", () => {

    beforeEach(async () => {
        DI.clear();

        DI.register(ConnectionConf).as(Configuration);
        DI.register(SqliteOrmDriver).as("orm-driver-sqlite");
        DI.register(SpinaJsDefaultLog).as(LogModule);

        DI.resolve(LogModule);
        await DI.resolve(Orm);
    });

    afterEach(async () => {
        DI.clear();
    });

    it("Should migrate create migrate table", async () => {

        await db().migrateUp();
        const mTable = await db().Connections.get("sqlite").tableInfo(TEST_MIGRATION_TABLE_NAME);
        const mResult = await db().Connections.get("sqlite").select().from(TEST_MIGRATION_TABLE_NAME).first();
        expect(mTable).to.be.not.null;
        expect(mResult).to.be.not.null;
        expect((mResult as any).Migration).to.eq("TestMigration");
    });

    it("Should not migrate twice", async () => {
        const spy = sinon.spy(TestMigration.prototype, "up");

        await db().migrateUp();
        await db().migrateUp();

        expect(spy.calledOnce).to.be.true;
    });

    it("Should migrate", async () => {

        await db().migrateUp();
        await db().Connections.get("sqlite").insert().into("user").values({
            Name: "test",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });
        const result = await db().Connections.get("sqlite").select().from("user").first();

        expect(result).to.be.not.null;
        expect(result).to.eql({
            Id: 1,
            Name: "test",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });
    })
});

describe("Sqlite model functions", () =>{

    beforeEach(async () => {
        DI.register(ConnectionConf).as(Configuration);
        DI.register(SqliteOrmDriver).as("orm-driver-sqlite");
        DI.register(SpinaJsDefaultLog).as(LogModule);

        DI.resolve(LogModule);
        await DI.resolve(Orm);

        await db().migrateUp();
        await db().reloadTableInfo();
    });

    afterEach(async () => {
        DI.clear();
    });

    it("should model create", async ()=>{

        const user = await User.create<User>({
            Name: "test",
            Password: "test_password"
        });

        const result : any = await db().Connections.get("sqlite").select().from("user").first();

        expect(result).to.be.not.null;
        expect(result.Id).to.eq(1);
        expect(result.Name).to.eq("test");
        expect(result.Password).to.eq("test_password");

        expect(user).to.be.not.null;
        expect(user.Id).to.eq(1);
        expect(user.Name).to.eq("test");
        expect(user.Password).to.eq("test_password");
    })
});

describe("Sqlite queries", () => {

    beforeEach(async () => {
        DI.register(ConnectionConf).as(Configuration);
        DI.register(SqliteOrmDriver).as("orm-driver-sqlite");
        DI.register(SpinaJsDefaultLog).as(LogModule);

        DI.resolve(LogModule);
        await DI.resolve(Orm);

        await db().migrateUp();
        await db().reloadTableInfo();
    });

    afterEach(async () => {
        DI.clear();
    });

    it("should select and sort", async () => {
        await db().Connections.get("sqlite").insert().into("user").values({
            Name: "a",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });

        await db().Connections.get("sqlite").insert().into("user").values({
            Name: "b",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });

        const userQuery = User.where(function (this: IWhereBuilder) {
            this.where({ Name: "a" });
        }).orderBy("Name");

        return expect(userQuery).to.be.fulfilled;
    })

    it("should select to model", async () => {
        await db().Connections.get("sqlite").insert().into("user").values({
            Name: "test",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });

        const user = await User.find<User>(1);

        expect(user).instanceOf(User);
        expect(user.Id).to.eq(1);
        expect(user.Name).to.eq("test");
    });

    it("should map datetime", async () => {
        
        await db().Connections.get("sqlite").insert().into("user").values({
            Name: "test",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });

        const user = await User.find<User>(1);

        expect(user).instanceOf(User);
        expect(user.CreatedAt).instanceof(Date);
    });

    it("should run on duplicate", async () => {
        await db().Connections.get("sqlite").insert().into("user").values({
            Name: "test",
            Password: "test_password",
            CreatedAt: "2019-10-18"
        });

        await User.insert({Id: 1, Name: "test2", Password: "test_password_2", CreatedAt: "2019-10-19"}).onDuplicate("Id").update(["Name", "Password"]);

        const all = await User.all<User>();
        const user = await User.find<User>(1);

        expect(user).instanceOf(User);
        expect(user.CreatedAt).instanceof(Date);
        expect(user.Name).to.eq("test2");
        expect(user.Password).to.eq("test_password_2");
        expect(all.length).to.eq(1);
    });
})