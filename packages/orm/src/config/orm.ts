/**
 * `@spinajs/orm` ships no migrations of its own - this key exists only so an app knows
 * `system.dirs.migrations` is the config surface for `FilesystemMigrationSource`, and documents it.
 *
 * It is an empty array on purpose, not the three cwd build-layout paths you might expect here.
 * Package configs merge into the app's config by ARRAY CONCAT (`mergeArrays` in
 * `@spinajs/configuration`'s `util-common.ts`), so anything non-empty shipped here would sit in
 * every app's scan set forever, on top of whatever that app configures, with no way to switch it
 * off. The three cwd defaults ( `src/migrations`, `lib/migrations`, `dist/migrations` - one per
 * build layout a project might have been compiled to ) live instead as `DEFAULT_MIGRATION_DIRS` in
 * `migration-sources.ts`, and `FilesystemMigrationSource` falls back to them only when this key is
 * absent or empty - so a configured value REPLACES them rather than adding to them.
 */
const orm = {
  system: {
    dirs: {
      migrations: [] as string[],
    },
  },
};

export default orm;
