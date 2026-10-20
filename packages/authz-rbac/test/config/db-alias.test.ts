import * as chai from 'chai';
import 'mocha';
import _ from 'lodash';

import dbConfig from '../../src/config/db.js';
import { bootDb } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

describe('db.Aliases.authz default', function () {
  this.timeout(60000);

  let db: TestDb | undefined;

  after(async () => {
    await db?.dispose();
  });

  it('maps the alias to the default connection', () => {
    expect(dbConfig).to.deep.equal({ db: { Aliases: { authz: 'default' } } });
  });

  it('loses to an app value merged after it', () => {
    expect(_.merge({}, dbConfig, { db: { Aliases: { authz: 'tenant' } } })).to.deep.equal({ db: { Aliases: { authz: 'tenant' } } });
  });

  it('reaches a booted ORM from the compiled package config', async function () {
    db = await bootDb(this, 'sqlite', 'alias_default');
    expect(db.orm.Connections.get('authz')).to.equal(db.driver);
  });
});
