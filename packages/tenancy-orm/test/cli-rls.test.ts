import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IOFail, InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

import { TenantRlsCommand } from '../src/cli/commands/tenant-rls.js';
import { register, unregisterTenantModel } from '../src/registry.js';
import { TenantOwned } from './support/models.js';
import { bootRlsApp } from './support/rls-app.js';
import type { RlsApp } from './support/rls-app.js';
import { declareRlsModels, forgetRlsModels } from './support/rls-models.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('tenant:rls', function () {
  this.timeout(120_000);
  let rls: RlsApp | undefined;
  let dir: string;
  const lines: string[] = [];

  before(async () => {
    declareRlsModels();
    rls = await bootRlsApp();
  });

  after(async () => {
    await rls?.dispose();
    forgetRlsModels();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tenant-rls-'));
    lines.length = 0;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (options: { bypassRole?: string } = {}, now?: Date): Promise<void> => {
    const command = Object.assign(new TenantRlsCommand(), { Orm: rls?.orm, Print: (line: string) => void lines.push(line) });
    if (now !== undefined) command.Now = () => now;
    return command.execute({ out: dir, ...options });
  };

  // Ledger (support/models.ts) is a model with rls on the sqlite connection.
  async function withoutLedger(fn: () => Promise<void>): Promise<void> {
    unregisterTenantModel(TenantOwned);
    register(TenantOwned, undefined, '@Tenant()');
    try {
      await fn();
    } finally {
      unregisterTenantModel(TenantOwned);
      register(TenantOwned, { rls: true }, '@Tenant()');
    }
  }

  const written = (): { file: string; source: string } => {
    const files = readdirSync(dir);
    expect(files).to.have.length(1);
    return { file: files[0], source: readFileSync(join(dir, files[0]), 'utf8') };
  };

  it('writes one migration with the tenant policies of the rls tables of a connection', () =>
    withoutLedger(async () => {
      await run({ bypassRole: 'app_ops' });
      const { file, source } = written();
      expect(file).to.match(/^TenantRls_\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}\.ts$/);
      expect(source).to.include('@Migration("rls")').and.include('AS RESTRICTIVE').and.include("pg_has_role('app_ops', 'MEMBER')");
      expect(source).to.include('\\"rls_invoice\\"').and.include('\\"rls_memo\\"').and.include('await connection.schema().raw(sql);');
      expect(lines[0]).to.eq(`wrote ${join(dir, file)}`);
      expect(lines.slice(1)).to.have.members(['  rls_invoice: restrictive policy on tenant_id, bypass role app_ops', '  rls_memo: restrictive policy on tenant_id, bypass role app_ops']);
    }));

  it('takes the bypass role from tenancy.orm.rlsBypassRole', () =>
    withoutLedger(async () => {
      // Left set: Configuration.set() checks the value against the schema, which refuses an empty role. The tests after
      // this one do not read the role, and the application ends with this file.
      rls?.app.config.set(['tenancy', 'orm', 'rlsBypassRole'], 'app_cfg');
      await run();
      expect(written().source).to.include("pg_has_role('app_cfg', 'MEMBER')");
    }));

  it('refuses an empty --bypass-role, and writes nothing', () =>
    withoutLedger(async () => {
      await expect(run({ bypassRole: ' ' })).to.be.rejectedWith(InvalidArgument, '--bypass-role is empty');
      expect(readdirSync(dir)).to.deep.eq([]);
    }));

  it('never replaces the file of a run in the same second', () =>
    withoutLedger(async () => {
      const now = new Date();
      await run({ bypassRole: 'first' }, now);
      await expect(run({ bypassRole: 'second' }, now)).to.be.rejectedWith(IOFail, 'already exists');
      expect(written().source).to.include("pg_has_role('first', 'MEMBER')");
    }));

  it('refuses a table with rls on a connection that is not PostgreSQL, and writes nothing', async () => {
    await expect(run()).to.be.rejectedWith(InvalidOperation, 'ledger is on connection default, which is not PostgreSQL');
    expect(readdirSync(dir)).to.deep.eq([]);
  });

  it('refuses to write a migration without a table with rls', () =>
    withoutLedger(async () => {
      forgetRlsModels();
      try {
        await expect(run()).to.be.rejectedWith(InvalidOperation, 'no row-mode tenant model declares rls');
      } finally {
        declareRlsModels();
      }
    }));
});
