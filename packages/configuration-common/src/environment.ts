/**
 * The environment name spinajs matches file suffixes against.
 *
 * One function rather than one per consumer: config file loading ( `foo.dev.js` ) and migration
 * file loading ( `Foo_2026_07_29_10_00_00.dev.ts` ) MUST agree on what `dev` means, or a
 * deployment would load its dev config while running its prod migrations.
 *
 * Case is deliberately not folded: `Local` and `local` are different environments, exactly as
 * they are to the shell that sets APP_ENV.
 */
export function normalizeEnvironment(env?: string | null): string {
  // empty string is "unset" - an exported-but-blank APP_ENV must not become an environment named ''
  const value = env && env.length > 0 ? env : 'production';

  switch (value) {
    case 'dev':
    case 'development':
      return 'dev';
    case 'prod':
    case 'production':
      return 'prod';
    default:
      return value;
  }
}
