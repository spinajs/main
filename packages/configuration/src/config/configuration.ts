import { normalizeEnvironment } from '@spinajs/configuration-common';

/**
 * The single source of truth for "which environment am I running as".
 *
 * Derived from the SAME value that selects the config files - `APP_ENV`, falling back to
 * `NODE_ENV` - and run through the SAME normalizer, so a guard reading these flags and the config
 * that was actually loaded can never disagree. Reading `NODE_ENV` directly, as this used to,
 * disagreed in two ways:
 *
 *  - A container may pin `NODE_ENV=production` so npm installs production dependencies, and then
 *    distinguish its stacks with `APP_ENV`. Such a dev container reported production.
 *  - Only the spelling `production` matched, so `APP_ENV=prod` - which `normalizeEnvironment` maps
 *    onto the prod config suffix - reported false.
 *
 * Both are fail-open for consumers that guard on this: the http package hides error detail on
 * production, and the email package refuses recipient redirection there.
 *
 * These stay ordinary configuration values, so an app may override them in its own config - that
 * is the point of deciding it here rather than re-deriving it at each call site.
 *
 * @param env - process.env, taken as an argument so the derivation is testable without reloading
 *              the module
 */
export function buildEnvironmentFlags(env: NodeJS.ProcessEnv) {
  // `?? 'development'` mirrors FrameworkConfiguration.load(), which resolves
  // `Env ?? APP_ENV ?? NODE_ENV ?? 'development'`. Without it a bare process would fall through to
  // normalizeEnvironment's own default of production and call a developer's laptop prod.
  //
  // An explicitly EMPTY APP_ENV is deliberately NOT caught by that default: `??` tests only
  // null/undefined, so `APP_ENV=` reaches normalizeEnvironment, which resolves it to production -
  // and such a deployment really does load its prod config. The flag agrees rather than papering
  // over it.
  const environment = normalizeEnvironment(env.APP_ENV ?? env.NODE_ENV ?? 'development');

  return {
    isDevelopment: environment === 'dev',
    isProduction: environment === 'prod',
    isLocal: environment === 'local',
  };
}

const config = {
  configuration: buildEnvironmentFlags(process.env),

  app: {
    name: 'spinajs',
    version: '1.0.0',
  },
};

export default config;
