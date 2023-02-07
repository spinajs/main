var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, Migration } from '@spinajs/orm';
let Test_2022_06_28_01_13_00 = class Test_2022_06_28_01_13_00 extends OrmMigration {
    async up(connection) {
        await connection.schema().createTable('belongs', (table) => {
            table.int('Id').primaryKey().notNull();
            table.string('Text', 32).notNull();
        });
        await connection.insert().into('belongs').values({ Text: 'belongs 1', Id: 1 });
        await connection.insert().into('belongs').values({ Text: 'belongs 1', Id: 2 });
        await connection.schema().createTable('test', (table) => {
            table.int('Id').primaryKey().notNull();
            table.string('Text', 32).notNull();
            table.int('belongs_id');
        });
        await connection.insert().into('test').values({ Text: 'witaj', Id: 1, belongs_id: 1 });
        await connection.insert().into('test').values({ Text: 'swiecie', Id: 2, belongs_id: 2 });
        await connection.schema().createTable('test2', (table) => {
            table.int('Id').primaryKey().notNull();
            table.string('Text', 32).notNull();
            table.int('test_id');
        });
        await connection.insert().into('test2').values({ Text: 'hello', Id: 1, test_id: 1 });
        await connection.insert().into('test2').values({ Text: 'world', Id: 2, test_id: 2 });
        await connection.insert().into('test2').values({ Text: 'world', Id: 3, test_id: 1 });
        await connection.insert().into('test2').values({ Text: 'hello', Id: 4, test_id: 2 });
    }
    // tslint:disable-next-line: no-empty
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async down(_connection) { }
};
Test_2022_06_28_01_13_00 = __decorate([
    Migration('default')
], Test_2022_06_28_01_13_00);
export { Test_2022_06_28_01_13_00 };
//# sourceMappingURL=Test_2022_06_28_01_13_00.js.map