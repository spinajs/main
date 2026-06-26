/**
 * Watching config values for live updates (no restart).
 *
 * When an exposed option sets `watch: true`, a background timer periodically
 * re-reads it from the db and, if the value changed, pushes the new value into
 * the live configuration. Code that reads the value through `@Config` (or
 * `Configuration.get`) then sees the update without a restart.
 *
 * The poll interval defaults to 3 minutes. Override it by registering the
 * `__config_watch_interval__` DI value (milliseconds) BEFORE the ORM resolves.
 *
 * Run:
 *   node lib/mjs/examples/03-watch-config.js
 */
import { DI } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import '@spinajs/configuration-db-source';

// poll the db every 30s instead of the 3 min default
DI.register({ value: 30_000 }).asValue('__config_watch_interval__');

export class FeatureFlags {
  @Config('features.checkoutV2', {
    defaultValue: false,
    expose: true,
    exposeOptions: {
      type: 'boolean',
      group: 'features',
      label: 'Checkout v2',
      watch: true, // <-- reloaded from db on every tick
    },
  })
  public CheckoutV2: boolean;
}

/**
 * Toggle the flag in the database. The next watch tick (<= 30s here) copies the
 * new value into the live config, so `flags.CheckoutV2` flips on its own.
 */
export async function enableCheckoutV2() {
  // Write through the model or any sql tool, eg:
  //   await DbConfig.update({ Value: '1' }).where('Slug', 'features.checkoutV2');
  const cfg = await DI.resolve(Configuration);
  console.log('current value:', cfg.get('features.checkoutV2'));
}
