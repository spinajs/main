/**
 * Environments where recipient redirection is refused outright, whatever a connection
 * configures. Compared against the value `@spinajs/configuration` resolves into
 * `process.env.APP_ENV` — the same value it uses to choose which config file loads, so the
 * guard and the loaded configuration cannot disagree.
 *
 * `prod` is here as well as `production` because `configuration.isProduction` is
 * `NODE_ENV === 'production'` exactly, and a stack running `NODE_ENV=prod` reports false there.
 */
const PRODUCTION_ENVS = ['production', 'prod'];

export function isProductionEnv(env: string | undefined): boolean {
  return PRODUCTION_ENVS.includes((env ?? '').trim().toLowerCase());
}
