import 'mocha';
import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import type { OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { Upload_2026_10_23_00_00_00 } from '../src/index.js';
import { bootConfiguration } from './support/config.js';
import { POSTGRES, connectPostgres, postgresAdmin, requireServer } from './support/servers.js';

describe('Upload_2026_10_23_00_00_00 on postgres', function () {
  this.timeout(60000);
  const database = `upload_migration_${randomBytes(4).toString('hex')}`;
  let driver: OrmDriver | undefined;

  before(async function () {
    await bootConfiguration();
    await requireServer(this, 'postgres', POSTGRES.Host, POSTGRES.Port);
    await postgresAdmin(`CREATE DATABASE ${database}`);
    driver = await connectPostgres(database);
    await new Upload_2026_10_23_00_00_00().up(driver);
  });

  after(async () => {
    if (!driver) return;
    await driver.disconnect();
    await postgresAdmin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });

  it('indexes the owed final events', async () => {
    const found = (await driver!.select().from('pg_indexes').where('indexname', 'upload_sessions_final_event')) as { indexdef: string }[];
    expect(found).to.have.length(1);
    expect(found[0].indexdef).to.match(/\(final_event, final_event_at\)/);
  });

  it('stores a size past 32 bits, and deleting a session removes its parts and blobs', async () => {
    const d = driver!;
    const now = DateTime.utc();
    await d.insert().into('upload_sessions').values({ id: 's-1', name: 'big.bin', size: 3_000_000_000, part_size: 8_388_608, part_count: 358, status: 'open', metadata: '{}', temp_fs: 't', files_fs: 'f', created_at: now, updated_at: now, expires_at: now });
    await d.insert().into('upload_parts').values({ session_id: 's-1', number: 1, size: 8_388_608, sha256: 'a'.repeat(64), storage_key: 'k1', received_at: now });
    await d.insert().into('upload_blobs').values({ id: 'b-1', session_id: 's-1', fs: 't', key: 'k1', kind: 'part', state: 'live', created_at: now, updated_at: now });

    const [session] = (await d.select().from('upload_sessions').where('id', 's-1')) as { size: string | number }[];
    expect(Number(session.size)).to.eq(3_000_000_000);

    await d.del().from('upload_sessions').where('id', 's-1');
    expect(await d.select().from('upload_parts')).to.deep.equal([]);
    expect(await d.select().from('upload_blobs')).to.deep.equal([]);
  });

  it('stores a part size past 32 bits, up to the 5 GiB part ceiling', async () => {
    const d = driver!;
    const now = DateTime.utc();
    const partSize = 5 * 1024 ** 3;
    await d.insert().into('upload_sessions').values({ id: 's-big-part', name: 'huge.bin', size: 2 * partSize, part_size: partSize, part_count: 2, status: 'open', metadata: '{}', temp_fs: 't', files_fs: 'f', created_at: now, updated_at: now, expires_at: now });

    const [session] = (await d.select().from('upload_sessions').where('id', 's-big-part')) as { part_size: string | number }[];
    expect(Number(session.part_size)).to.eq(partSize);
    await d.del().from('upload_sessions').where('id', 's-big-part');
  });
});
