/** What a scan of a `system.dirs` key matches, for every section but migrations. */
export const SCAN_GLOB = '/**/!(*.d).{ts,js}';

const MIGRATION_EXTENSIONS = '{ts,js,cjs,mjs}';

/** A migration scan matches unsuffixed files, which belong to every environment, and files tagged with this one. */
export const migrationScanGlobs = (env: string): string[] => [`/**/!(*.*).${MIGRATION_EXTENSIONS}`, `/**/*.${env}.${MIGRATION_EXTENSIONS}`];

const baseName = (file: string): string => file.split(/[\\/]/).pop() ?? file;

/** `SCAN_GLOB` as a test on a file's built name. */
export function matchesScanGlob(file: string): boolean {
  const stem = /^(?!\.)(.+)\.(?:ts|js)$/.exec(baseName(file))?.[1];
  return stem !== undefined && !stem.endsWith('.d');
}

/** `migrationScanGlobs` as a test on a file's built name; without `env`, whether some environment can match it. */
export function matchesMigrationGlob(file: string, env?: string): boolean {
  const stem = /^(?!\.)(.+)\.(?:ts|js|cjs|mjs)$/.exec(baseName(file))?.[1];
  if (stem === undefined) return false;
  return env === undefined || !stem.includes('.') || stem.endsWith(`.${env}`);
}
