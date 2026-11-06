import 'mocha';
import { expect } from 'chai';

import { availableTargets } from '../src/targets.js';

describe('availableTargets', () => {
  it('always runs PGlite first, then sqlite', () => {
    expect(availableTargets({}).map((t) => t.name)).to.deep.equal(['pglite', 'sqlite']);
  });

  it('adds a server for each ORM_CONFORMANCE_* URL', () => {
    const targets = availableTargets({
      ORM_CONFORMANCE_POSTGRES: 'postgres://postgres:p%40ss@127.0.0.1:15432/test',
      ORM_CONFORMANCE_MSSQL: 'mssql://sa:yourStrong(!)Password@127.0.0.1:1433/test',
    });

    expect(targets.map((t) => t.name)).to.deep.equal(['pglite', 'sqlite', 'postgres', 'mssql']);
    expect(targets[2].connection).to.deep.equal({ Driver: 'orm-driver-postgres', Host: '127.0.0.1', Port: 15432, User: 'postgres', Password: 'p@ss', Database: 'test' });
    expect(targets[3].connection).to.deep.equal({
      Driver: 'orm-driver-mssql',
      Host: '127.0.0.1',
      Port: 1433,
      User: 'sa',
      Password: 'yourStrong(!)Password',
      Database: 'test',
      Options: { TrustServerCertificate: true, Schema: 'dbo' },
    });
  });
});
