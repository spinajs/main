import 'mocha';
import * as chai from 'chai';
import _ from 'lodash';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration, ConfigurationOverlay, ConfigurationSource } from '@spinajs/configuration-common';

import { NoSource } from './fixtures.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { InvalidConfiguration } from '../src/exception.js';

const expect = chai.expect;

const TREE = { mail: { from: 'noreply@app.test', retries: 3 }, intl: { defaultLocale: 'en' }, limits: { exports: 10, uploads: 5 } };

const isPrefix = (a: readonly string[], b: readonly string[]): boolean => {
  const n = Math.min(a.length, b.length);
  return _.isEqual(a.slice(0, n), b.slice(0, n));
};

/** Covers the paths a test lists and answers the values it sets. */
class FixedOverlay extends ConfigurationOverlay {
  public static paths: string[][] = [];
  public static current: ReadonlyMap<string, unknown> | undefined;
  public static attached = 0;

  public attach(): void {
    FixedOverlay.attached += 1;
  }

  public covers(path: readonly string[]): boolean {
    return FixedOverlay.paths.some((p) => isPrefix(p, path));
  }

  public values(): ReadonlyMap<string, unknown> | undefined {
    return FixedOverlay.current;
  }
}

const booted: IContainer[] = [];

async function boot(overlay: boolean): Promise<FrameworkConfiguration> {
  const child = DI.child();
  booted.push(child);
  child.register(NoSource).as(ConfigurationSource);
  if (overlay) child.register(FixedOverlay).as(ConfigurationOverlay);
  child
    .register(
      class extends FrameworkConfiguration {
        protected loadSources(): void {
          this.Sources = [];
        }

        protected onLoad(): unknown {
          return structuredClone(TREE);
        }
      },
    )
    .as(Configuration);
  return (await child.resolve(Configuration)) as FrameworkConfiguration;
}

describe('configuration overlay', () => {
  beforeEach(() => {
    FixedOverlay.paths = [
      ['mail', 'from'],
      ['limits', 'exports'],
    ];
    FixedOverlay.current = undefined;
    FixedOverlay.attached = 0;
  });

  afterEach(async () => {
    for (const c of booted.splice(0).reverse()) await c.dispose();
  });

  it('without a registered overlay reads the merged tree, and no path is overlaid', async () => {
    const config = await boot(false);
    FixedOverlay.current = new Map([['mail.from', 'billing@acme.test']]);

    expect(config.get('mail.from')).to.equal('noreply@app.test');
    expect(config.get(['limits', 'exports'])).to.equal(10);
    expect(config.isOverlaid('mail.from')).to.equal(false);
    expect(FixedOverlay.attached).to.equal(0);
  });

  it('attaches the registered overlay once it resolved, and again after a reload', async () => {
    const config = await boot(true);
    expect(FixedOverlay.attached).to.equal(1);

    await config.load();

    expect(FixedOverlay.attached).to.equal(2);
  });

  it('answers an overridden path from the overlay and every other path from the merged tree', async () => {
    const config = await boot(true);
    FixedOverlay.current = new Map([['mail.from', 'billing@acme.test']]);

    expect(config.get('mail.from')).to.equal('billing@acme.test');
    expect(config.get(['mail', 'retries'])).to.equal(3);
    expect(config.get('intl.defaultLocale')).to.equal('en');
    expect(config.isOverlaid('mail.from')).to.equal(true);
    expect(config.isOverlaid('mail')).to.equal(true);
    expect(config.isOverlaid('intl.defaultLocale')).to.equal(false);
  });

  it('lays an override into a copy of the parent a read asks for, and leaves the merged tree alone', async () => {
    const config = await boot(true);
    FixedOverlay.current = new Map<string, unknown>([
      ['mail.from', 'billing@acme.test'],
      ['limits.exports', 50],
    ]);

    expect(config.get('mail')).to.deep.equal({ from: 'billing@acme.test', retries: 3 });
    expect(config.get('limits')).to.deep.equal({ exports: 50, uploads: 5 });

    FixedOverlay.current = undefined;
    expect(config.get('mail')).to.deep.equal({ from: 'noreply@app.test', retries: 3 });
  });

  it('reads below an overridden object, and the default when the override has no such key', async () => {
    const config = await boot(true);
    FixedOverlay.paths = [['mail']];
    FixedOverlay.current = new Map<string, unknown>([['mail', { from: 'billing@acme.test' }]]);

    expect(config.get('mail.from')).to.equal('billing@acme.test');
    expect(config.get('mail.retries', 7)).to.equal(7);
  });

  it('answers the merged tree when the overlay has no values, and for a path it does not cover', async () => {
    const config = await boot(true);

    expect(config.get('mail.from')).to.equal('noreply@app.test');

    FixedOverlay.current = new Map([['intl.defaultLocale', 'de']]);
    expect(config.get('intl.defaultLocale')).to.equal('en');
  });

  it('merge() writes into the merged tree, never into an overlaid copy', async () => {
    const config = await boot(true);
    FixedOverlay.current = new Map([['mail.from', 'billing@acme.test']]);

    config.merge('mail', { retries: 5 });

    FixedOverlay.current = undefined;
    expect(config.get('mail')).to.deep.equal({ from: 'noreply@app.test', retries: 5 });
  });

  describe('check()', () => {
    const MAIL = { $id: 'test-overlay-mail', $configurationModule: 'mail', type: 'object', properties: { from: { type: 'string', pattern: '@' }, retries: { type: 'integer', minimum: 0 } } };

    async function bootWithSchema(): Promise<FrameworkConfiguration> {
      const child = DI.child();
      booted.push(child);
      child.register(MAIL).asValue('__configurationSchema__');
      child.register(NoSource).as(ConfigurationSource);
      child
        .register(
          class extends FrameworkConfiguration {
            protected loadSources(): void {
              this.Sources = [];
            }

            protected onLoad(): unknown {
              return structuredClone(TREE);
            }
          },
        )
        .as(Configuration);
      return (await child.resolve(Configuration)) as FrameworkConfiguration;
    }

    it('refuses a value its module schema refuses, and changes nothing either way', async () => {
      const config = await bootWithSchema();

      expect(() => config.check('mail.from', 'not an address')).to.throw(InvalidConfiguration);
      expect(() => config.check(['mail', 'retries'], -1)).to.throw(InvalidConfiguration);
      config.check('mail.from', 'billing@acme.test');

      expect(config.get('mail.from')).to.equal('noreply@app.test');
    });

    it('accepts a value where no schema applies', async () => {
      const config = await bootWithSchema();

      config.check('limits.exports', 'anything');

      expect(config.get('limits.exports')).to.equal(10);
    });
  });
});
