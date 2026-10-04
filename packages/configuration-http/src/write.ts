import type { DbConfig } from '@spinajs/configuration-db-source';
import { ConfigWriteRefused } from './errors.js';

/**
 * Persists the entry. A conditional `configuration:update` grant is part of the UPDATE's WHERE, so a
 * row outside it matches nothing and the query still succeeds: that must not read as a write.
 */
export async function updateEntry(entry: DbConfig): Promise<void> {
  const pending = entry.changeSet().length > 0;
  const result = await entry.update();
  if (pending && result.RowsAffected === 0) {
    throw new ConfigWriteRefused(`configuration entry '${entry.Slug}' is outside your update permission`);
  }
}
