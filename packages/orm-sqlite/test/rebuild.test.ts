import { NotSupported } from '@spinajs/exceptions';
import type { AlterColumnQueryBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';

import { createTableParts, definedColumn, modifiedDefinition } from '../src/rebuild.js';

const expect = chai.expect;

const column = (spec: Partial<AlterColumnQueryBuilder>) => ({ Name: 'c', PrimaryKey: false, Unique: false, Collation: '', ...spec }) as AlterColumnQueryBuilder;

describe('sqlite table rebuild', () => {
  it('splits a table body at its top-level commas', () => {
    const { body, tail } = createTableParts("CREATE TABLE `t` (`a` TEXT DEFAULT 'x,y', `b` DECIMAL(8,2), CHECK (a IN ('1', '2')), PRIMARY KEY (a, b)) WITHOUT ROWID");
    expect(body).to.deep.equal(["`a` TEXT DEFAULT 'x,y'", '`b` DECIMAL(8,2)', "CHECK (a IN ('1', '2'))", 'PRIMARY KEY (a, b)']);
    expect(tail).to.equal('WITHOUT ROWID');
  });

  it('names the column a definition declares, not a table constraint', () => {
    expect(definedColumn('"Session Id" TEXT')).to.equal('Session Id');
    expect(definedColumn('[Data] TEXT')).to.equal('Data');
    expect(definedColumn('PRIMARY KEY (a)')).to.equal(undefined);
    expect(definedColumn('CONSTRAINT pk PRIMARY KEY (a)')).to.equal(undefined);
  });

  it('keeps the constraints the builder does not restate', () => {
    expect(modifiedDefinition('`Id` TEXT NOT NULL PRIMARY KEY', column({ Name: 'Id' }), '`Id` TEXT')).to.equal('`Id` TEXT PRIMARY KEY');
    expect(modifiedDefinition('`Id` INTEGER CONSTRAINT pk PRIMARY KEY AUTOINCREMENT', column({ Name: 'Id' }), '`Id` INTEGER NOT NULL')).to.equal('`Id` INTEGER NOT NULL CONSTRAINT pk PRIMARY KEY AUTOINCREMENT');
    expect(modifiedDefinition('`UserId` INTEGER NOT NULL REFERENCES users(Id) ON DELETE SET NULL', column({ Name: 'UserId' }), '`UserId` INTEGER')).to.equal('`UserId` INTEGER REFERENCES users(Id) ON DELETE SET NULL');
    expect(modifiedDefinition("`s` TEXT DEFAULT 'a' COLLATE NOCASE UNIQUE", column({ Name: 's' }), '`s` TEXT NOT NULL')).to.equal('`s` TEXT NOT NULL COLLATE NOCASE UNIQUE');
  });

  it('drops what the builder restates', () => {
    expect(modifiedDefinition('`Id` TEXT PRIMARY KEY UNIQUE', column({ Name: 'Id', PrimaryKey: true, Unique: true }), '`Id` TEXT PRIMARY KEY UNIQUE')).to.equal('`Id` TEXT PRIMARY KEY UNIQUE');
    expect(modifiedDefinition('`b` BOOLEAN NOT NULL CHECK ( `b` IN (0, 1))', column({ Name: 'b' }), '`b` BOOLEAN NOT NULL CHECK ( `b` IN (0, 1))')).to.equal('`b` BOOLEAN NOT NULL CHECK ( `b` IN (0, 1))');
  });

  it('refuses a generated column', () => {
    expect(() => modifiedDefinition('`g` INTEGER GENERATED ALWAYS AS (a + 1)', column({ Name: 'g' }), '`g` INTEGER')).to.throw(NotSupported);
  });
});
