import 'mocha';
import { expect } from 'chai';

import { buildEnvironmentFlags } from '../src/config/configuration.js';

/**
 * `configuration.isProduction` is the single source of truth for "am I running as production",
 * so it has to agree with the environment spinajs actually loaded its config from.
 *
 * It used to be `process.env.NODE_ENV === 'production'`, which disagreed in two ways that bite:
 *
 *  - Config files are selected from APP_ENV, not NODE_ENV. A container can pin NODE_ENV for npm's
 *    benefit and distinguish stacks with APP_ENV - yourscreen's worker Dockerfile does exactly
 *    that, setting NODE_ENV=production on every stack including dev. Reading NODE_ENV there
 *    reports production on a dev box.
 *  - Only the spelling `production` matched, so a stack running APP_ENV=prod - which
 *    `normalizeEnvironment` maps to the prod config suffix - reported false.
 *
 * Both are fail-open for anything that guards on this flag: @spinajs/http hides error detail on
 * production, and @spinajs/email refuses recipient redirection there.
 *
 * Pure function test - no container, no DI.
 */
describe('configuration environment flags', () => {
  it('derives from APP_ENV, which is what selects the config files', () => {
    expect(buildEnvironmentFlags({ APP_ENV: 'prod' }).isProduction).to.equal(true);
    expect(buildEnvironmentFlags({ APP_ENV: 'production' }).isProduction).to.equal(true);
    expect(buildEnvironmentFlags({ APP_ENV: 'dev' }).isDevelopment).to.equal(true);
    expect(buildEnvironmentFlags({ APP_ENV: 'development' }).isDevelopment).to.equal(true);
    expect(buildEnvironmentFlags({ APP_ENV: 'local' }).isLocal).to.equal(true);
  });

  it('lets APP_ENV win over NODE_ENV', () => {
    // The case that motivated this: a Dockerfile pins NODE_ENV=production on every stack so npm
    // installs production dependencies, and APP_ENV is what actually says which stack this is.
    // Reading NODE_ENV would call that dev container production.
    const flags = buildEnvironmentFlags({ NODE_ENV: 'production', APP_ENV: 'dev' });

    expect(flags.isProduction).to.equal(false);
    expect(flags.isDevelopment).to.equal(true);
  });

  it('falls back to NODE_ENV when APP_ENV is not set', () => {
    expect(buildEnvironmentFlags({ NODE_ENV: 'production' }).isProduction).to.equal(true);
    expect(buildEnvironmentFlags({ NODE_ENV: 'development' }).isDevelopment).to.equal(true);
  });

  it('treats nothing set as development, matching FrameworkConfiguration.load()', () => {
    // load() resolves `Env ?? APP_ENV ?? NODE_ENV ?? 'development'`, so a bare process is a dev
    // box. normalizeEnvironment on its own would answer 'production' for undefined, which is why
    // the default is applied here rather than left to it.
    const flags = buildEnvironmentFlags({});

    expect(flags.isDevelopment).to.equal(true);
    expect(flags.isProduction).to.equal(false);
  });

  it('treats an explicitly empty APP_ENV as production, matching config file selection', () => {
    // `APP_ENV=` is not the same as unset: normalizeEnvironment documents it as "unset" and
    // resolves it to production, so such a deployment loads its PROD config. The flag has to say
    // production too, or a guard would run dev-shaped on a prod-configured stack.
    expect(buildEnvironmentFlags({ APP_ENV: '' }).isProduction).to.equal(true);
  });

  it('leaves an unrecognised environment name false on every flag', () => {
    const flags = buildEnvironmentFlags({ APP_ENV: 'staging' });

    expect(flags.isProduction).to.equal(false);
    expect(flags.isDevelopment).to.equal(false);
    expect(flags.isLocal).to.equal(false);
  });
});
