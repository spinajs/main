import { readVersion } from '../../src/index.js';
import type { TestDb } from './db.js';

/** readVersion, after the ORM read the columns of the tables a migration in the test just created. */
export async function versionOf(db: TestDb, domain = 'root'): Promise<string> {
  await db.orm.reloadTableInfo();
  return readVersion(domain);
}
