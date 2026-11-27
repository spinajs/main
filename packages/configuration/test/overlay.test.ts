import 'mocha';
import * as chai from 'chai';
import _ from 'lodash';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { Configuration, ConfigurationOverlay, ConfigurationSource, ConfigVar } from '@spinajs/configuration-common';

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

class Secret {
  #value = 'hidden';

  public reveal(): string {
    return this.#value;
  }
}

const booted: IContainer[] = [];

interface BootOptions {
  tree?: () => unknown;
  schema?: object;
  onLoad?: (config: FrameworkConfiguration) => void;
}

async function boot(overlay: boolean, options: BootOptions = {}): Promise<FrameworkConfiguration> {
  const child = DI.child();
  booted.push(child);
  if (options.schema !== undefined) child.register(options.schema).asValue('__configurationSchema__');
  child.register(NoSource).as(ConfigurationSource);
  if (overlay) child.register(FixedOverlay).as(ConfigurationOverlay);
  child
    .register(
      class extends FrameworkConfiguration {
        protected loadSources(): void {
          this.Sources = [];
        }

        protected onLoad(): unknown {
          options.onLoad?.(this);
          return options.tree === undefined ? structuredClone(TREE) : options.tree();
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

  it('never overlays the empty path, and isOverlaid says so', async () => {
    const config = await boot(true);
    FixedOverlay.paths = [[]];
    FixedOverlay.current = new Map([['mail.from', 'billing@acme.test']]);

    expect(config.isOverlaid([])).to.equal(false);
    expect(config.isOverlaid('')).to.equal(false);
    expect(config.get([])).to.equal(undefined);
    expect(config.isOverlaid('mail')).to.equal(true);
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

  it('a value mutated in one unit of work shows neither in another nor in the merged tree', async () => {
    const config = await boot(true, { tree: () => ({ mail: { from: 'noreply@app.test', smtp: { host: 'smtp.app.test', port: 25 } } }) });
    FixedOverlay.paths = [['mail']];
    FixedOverlay.current = new Map([['mail.smtp.host', 'smtp.acme.test']]);

    const acme = config.get<{ from: string; smtp: { host: string; port: number } }>('mail');
    acme.from = 'changed';
    acme.smtp.port = 1;

    FixedOverlay.current = new Map([['mail.smtp.host', 'smtp.other.test']]);
    expect(config.get('mail')).to.deep.equal({ from: 'noreply@app.test', smtp: { host: 'smtp.other.test', port: 25 } });
    FixedOverlay.current = undefined;
    expect(config.get('mail')).to.deep.equal({ from: 'noreply@app.test', smtp: { host: 'smtp.app.test', port: 25 } });
  });

  it('copies only the objects on the way to an override: a class instance beside it is the merged one', async () => {
    const secret = new Secret();
    const config = await boot(true, { tree: () => ({ svc: { secret, name: 'x' } }) });
    FixedOverlay.paths = [['svc', 'name']];
    FixedOverlay.current = new Map([['svc.name', 'y']]);

    const svc = config.get<{ secret: Secret; name: string }>('svc');

    expect(svc.name).to.equal('y');
    expect(svc.secret).to.equal(secret);
    expect(svc.secret.reveal()).to.equal('hidden');
  });

  it('does not resolve a lazy configuration variable beside an override', async () => {
    let resolved = 0;
    const password = new ConfigVar(() => {
      resolved += 1;
      return 's3cret';
    });
    const config = await boot(true, { tree: () => ({ mail: { from: 'noreply@app.test', password } }) });
    FixedOverlay.current = new Map([['mail.from', 'billing@acme.test']]);
    const before = resolved;

    const mail = config.get<{ from: string; password: string }>('mail');

    expect(resolved).to.equal(before);
    expect(mail.from).to.equal('billing@acme.test');
    expect(mail.password).to.equal('s3cret');
  });

  it('lays the more specific override over the less specific one, and changes neither', async () => {
    const config = await boot(true, { tree: () => ({ mail: { from: 'noreply@app.test' } }) });
    FixedOverlay.paths = [['mail']];
    const smtp = { host: 'smtp.acme.test', port: 25 };
    FixedOverlay.current = new Map<string, unknown>([
      ['mail.smtp.port', 2525],
      ['mail.smtp', smtp],
    ]);

    expect(config.get('mail')).to.deep.equal({ from: 'noreply@app.test', smtp: { host: 'smtp.acme.test', port: 2525 } });
    expect(config.get('mail.smtp')).to.deep.equal({ host: 'smtp.acme.test', port: 2525 });
    expect(smtp).to.deep.equal({ host: 'smtp.acme.test', port: 25 });
  });

  it('an override of an array replaces it as a whole; an override of one index sets it in a copy of the array', async () => {
    const config = await boot(true, { tree: () => ({ limits: { hosts: ['a', 'b', 'c'] } }) });
    FixedOverlay.paths = [['limits']];

    FixedOverlay.current = new Map([['limits.hosts', ['x']]]);
    expect(config.get('limits')).to.deep.equal({ hosts: ['x'] });
    expect(config.get('limits.hosts')).to.deep.equal(['x']);

    FixedOverlay.current = new Map([['limits.hosts.1', 'y']]);
    expect(config.get('limits')).to.deep.equal({ hosts: ['a', 'y', 'c'] });
    expect(config.get('limits.hosts')).to.deep.equal(['a', 'y', 'c']);
    expect(config.get('limits.hosts.1')).to.equal('y');

    FixedOverlay.current = undefined;
    expect(config.get('limits.hosts')).to.deep.equal(['a', 'b', 'c']);
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
    const MAIL = {
      $id: 'test-overlay-mail',
      $configurationModule: 'mail',
      type: 'object',
      additionalProperties: false,
      properties: { from: { type: 'string', pattern: '@' }, retries: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' } },
    };

    const bootWithSchema = (overlay = false, options: BootOptions = {}) => boot(overlay, { ...options, schema: MAIL });

    it('refuses a value its module schema refuses with an error that names the key, and changes nothing either way', async () => {
      const config = await bootWithSchema();

      expect(() => config.check('mail.from', 'not an address')).to.throw(InvalidConfiguration, 'mail.from');
      expect(() => config.check(['mail', 'retries'], -1)).to.throw(InvalidConfiguration, 'mail.retries');
      config.check('mail.from', 'billing@acme.test');

      expect(config.get('mail.from')).to.equal('noreply@app.test');
    });

    it('returns the value as the schema accepted it: coerced, without undeclared keys', async () => {
      const config = await bootWithSchema();

      expect(config.check('mail.enabled', 'false')).to.equal(false);
      expect(config.check(['mail', 'retries'], '5')).to.equal(5);
      expect(config.check('mail', { from: 'b@acme.test', extra: { evil: true } })).to.deep.equal({ from: 'b@acme.test' });
    });

    it('an overlay that stores what check() returned serves the accepted value', async () => {
      const config = await bootWithSchema(true);
      FixedOverlay.paths = [['mail']];
      const raw: Array<[string, unknown]> = [
        ['mail.enabled', 'false'],
        ['mail.retries', '5'],
      ];
      FixedOverlay.current = new Map(raw.map(([path, value]) => [path, config.check(path, value)]));

      expect(config.get('mail.enabled')).to.equal(false);
      expect(config.get('mail')).to.deep.equal({ from: 'noreply@app.test', retries: 5, enabled: false });
    });

    it('returns a copy of the value where no schema applies', async () => {
      const config = await bootWithSchema();
      const value = { max: 3 };

      const checked = config.check('limits.exports', value);

      expect(checked).to.deep.equal(value);
      expect(checked).to.not.equal(value);
      expect(config.get('limits.exports')).to.equal(10);
    });

    it('refuses the empty path', async () => {
      const config = await bootWithSchema();

      expect(() => config.check([], {})).to.throw(InvalidArgument);
    });

    it('refuses to check while the configuration loads, by InvalidOperation, never by passing', async () => {
      const errors: unknown[] = [];
      const config = await bootWithSchema(false, {
        onLoad: (c) => {
          try {
            c.check('mail.retries', 'abc');
          } catch (e) {
            errors.push(e);
          }
        },
      });
      expect(errors).to.have.lengthOf(1);

      await config.load();

      expect(errors).to.have.lengthOf(2);
      for (const e of errors) expect(e).to.be.instanceOf(InvalidOperation);
      expect(() => config.check('mail.retries', 'abc')).to.throw(InvalidConfiguration);
    });
  });
});
