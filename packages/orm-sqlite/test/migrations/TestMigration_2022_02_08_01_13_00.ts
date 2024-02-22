/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('sqlite')
export class TestMigration_2022_02_08_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('user', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name').notNull().unique();
      table.string('Password').notNull();
      table.dateTime('CreatedAt').notNull();
      table.boolean('IsActive');
    });

    await connection.schema().createTable('test_model', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('owner_id');
      table.dateTime('CreatedAt').notNull();
    });

    await connection.schema().createTable('test_model_owner', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.dateTime('CreatedAt').notNull();
    });


    await connection.schema().createTable('test_owned', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('owner_id');
      table.string('Val');
    });

    await connection.schema().createTable('test_many', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Val');
      table.int('testmodel_id');
    });

    await connection.schema().createTable('has_many_1', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Val');
    });

    await connection.schema().createTable('owned_by_has_many_1', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Val');
      table.int('file_id');
      table.int('has_many_1_id');
    });

    await connection.schema().createTable('owned_by_owned_by_has_many_1', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Val');
    });

    await connection.schema().createTable('category', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
      table.int('parent_id');
    });

    await connection.index().unique().name('user_id_idx').columns(['Id', 'Name']).table('user');

    /**
     * Many to many test tables
     * 
     */

    await connection.schema().createTable('offer', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
    });

    await connection.schema().createTable('location', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
      table.int("Network_id");
    });

    await connection.schema().createTable('location_network', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.string('Name');
    });

    await connection.schema().createTable('offer_location', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();

      table.int("Localisation");
      table.int("Offer_id");
    });

    await connection.schema().createTable('locationmeta', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();

      table.string("Key");
      table.int("location_id");
    });

    await connection.schema().createTable('SetData', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
    });

    await connection.schema().createTable('SetItem', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();
      table.int('Val');
      table.int('dataset_id');
    });

    await connection.schema().createTable('locationnetworkmetadata', (table) => {
      table.int('Id').primaryKey().autoIncrement().unique();

      table.string("Key");
      table.int("network_id");
    });

    await connection.insert().into("SetData").values(
      [{
        Id: 1
      }, {
        Id: 2
      }, {
        Id: 3
      }]
    );

    await connection.insert().into("setitem").values([
      {
        dataset_id: 1,
        Val: 10
      },
      {
        dataset_id: 1,
        Val: 11
      },
      {
        dataset_id: 1,
        Val: 12
      },
      {
        dataset_id: 2,
        Val: 20
      },
      {
        dataset_id: 2,
        Val: 21
      },
      {
        dataset_id: 2,
        Val: 22
      },
      {
        dataset_id: 3,
        Val: 30
      },
      {
        dataset_id: 3,
        Val: 31
      },
      {
        dataset_id: 3,
        Val: 32
      }
    ]);

    await connection.insert().into("offer").values({
      Name: "Offer 1"
    });

    await connection.insert().into("location").values({
      Name: "Loc 1",
      Network_id: 1
    });

    await connection.insert().into("location").values({
      Name: "Loc 2",
      Network_id: 1
    });

    await connection.insert().into("location_network").values({
      Name: "Network 1"
    });

    await connection.insert().into("offer_location").values({
      Localisation: 1,
      Offer_id: 1
    });

    await connection.insert().into("offer_location").values({
      Localisation: 2,
      Offer_id: 1
    });


    await connection.insert().into("locationmeta").values({
      location_id: 1,
      Key: "meta 1"
    });

    await connection.insert().into("locationmeta").values({
      location_id: 2,
      Key: "meta 2"
    });


    await connection.insert().into("locationnetworkmetadata").values({
      network_id: 1,
      Key: "meta 1"
    });

    await connection.insert().into("locationnetworkmetadata").values({
      network_id: 1,
      Key: "meta 2"
    });
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> { }
}
