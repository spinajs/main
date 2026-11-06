import type { ColumnFamily, SqlDialectProfile } from '@spinajs/manifest';

/** The families a live native type can hold; undefined when the type or the dialect is unknown, so nothing is compared. */
export function familiesOf(nativeType: string, dialect: SqlDialectProfile | undefined): ColumnFamily[] | undefined {
  return dialect?.nativeTypes?.[nativeType.toLowerCase().replace(/\s*\(.*$/, '').trim()];
}

export function reportsNullability(dialect: SqlDialectProfile | undefined, family: ColumnFamily): boolean {
  return !dialect?.untrustedNullability?.includes(family);
}
