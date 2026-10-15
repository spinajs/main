import type { DbConfig } from '@spinajs/configuration-db-source';
import { ConfigWriteRefused } from './errors.js';

/**
 * Persists the entry. The route checked configuration:update on the row before, so zero rows affected means the row
 * went away in between: that must not read as a write.
 */
export async function updateEntry(entry: DbConfig): Promise<void> {
  const pending = entry.changeSet().length > 0;
  const result = await entry.update();
  if (pending && result.RowsAffected === 0) {
    throw new ConfigWriteRefused(`configuration entry '${entry.Slug}' is outside your update permission`);
  }
}
