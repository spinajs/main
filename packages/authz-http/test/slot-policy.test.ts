import 'mocha';
import { expect } from 'chai';
import { Config } from '@spinajs/configuration';
import { DI, NewInstance } from '@spinajs/di';
import { RouteRegistrationException } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { testHost } from '@spinajs/authz-testing';

import { SlotAccessContributor, SlotAccessPolicy, skipsAuthInDevelopment } from '../src/index.js';
import type { SlotSettings } from '../src/index.js';

@NewInstance()
class DemoAccessPolicy extends SlotAccessPolicy {
  protected readonly module = 'demo';

  @Logger('Security')
  protected Log: Log;

  @Config('demo.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('demo.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  @Config('demo.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('demo.auth.skipInDevelopment')
  protected SkipInDevelopment: unknown;

  @Config('configuration.isProduction')
  protected IsProduction: unknown;

  protected slotSettings(): SlotSettings {
    return { policies: this.Policies, permissions: this.Permissions, domain: this.Domain, skipInDevelopment: this.SkipInDevelopment, isProduction: this.IsProduction };
  }
}

class DemoContributor extends SlotAccessContributor {
  protected readonly module = 'demo';

  protected slotSettings() {
    return { policies: { read: 'AccessPolicy', other: 'SomePolicy' }, permissions: { read: ['demo:read', 'demo:list'] }, domain: 'root' };
  }
}

const DEMO_AUTH = { policies: { read: 'AccessPolicy', broken: 'NoSuchPolicy', self: 'DemoAccessPolicy', bare: 'AccessPolicy' }, permissions: { read: 'demo:read' }, domain: 'root' };

describe('SlotAccessPolicy', () => {
  before(async () => {
    const cfg = await testHost.installHost();
    cfg.set(['demo', 'auth'], DEMO_AUTH);
  });

  after(() => testHost.uninstallHost());

  it('names the missing slot key with the module prefix', () => {
    expect(() => DI.resolve(DemoAccessPolicy, ['nothing'])).to.throw(RouteRegistrationException, /demo\.auth\.policies\.nothing/);
  });

  it('refuses a slot naming an unregistered policy or the slot policy itself', () => {
    expect(() => DI.resolve(DemoAccessPolicy, ['broken'])).to.throw(/demo\.auth\.policies\.broken names NoSuchPolicy/);
    expect(() => DI.resolve(DemoAccessPolicy, ['self'])).to.throw(/must not name DemoAccessPolicy itself/);
  });

  it("refuses an 'AccessPolicy' slot without a permission entry", () => {
    expect(() => DI.resolve(DemoAccessPolicy, ['bare'])).to.throw(RouteRegistrationException, /demo\.auth\.permissions\.bare must be a permission name/);
  });

  it('refuses every endpoint while the module has no configuration, or an empty one', () => {
    const cfg = testHost.config();
    try {
      cfg.unset(['demo', 'auth']);
      expect(() => DI.resolve(DemoAccessPolicy, ['read']), 'no configuration').to.throw(RouteRegistrationException, /demo\.auth\.policies\.read must name a policy, but it is not set/);
      cfg.set(['demo', 'auth'], { policies: {}, permissions: {} });
      expect(() => DI.resolve(DemoAccessPolicy, ['read']), 'an empty configuration').to.throw(RouteRegistrationException, /demo\.auth\.policies\.read must name a policy, but it is not set/);
    } finally {
      cfg.set(['demo', 'auth'], DEMO_AUTH);
    }
  });

  it('resolves an AccessPolicy slot', () => {
    expect(() => DI.resolve(DemoAccessPolicy, ['read'])).to.not.throw();
  });

  it('contributes the permissions of AccessPolicy slots only, for its domain only', () => {
    const c = new DemoContributor();
    expect(c.contribute('root').permissionRefs?.map((r) => [r.permission, r.source])).to.deep.eq([
      ['demo:read', 'demo.auth.permissions.read'],
      ['demo:list', 'demo.auth.permissions.read'],
    ]);
    expect(c.contribute('other').permissionRefs).to.deep.eq([]);
  });

  it('skips in development only for the exact flag, a development env and no production flag', () => {
    expect(skipsAuthInDevelopment({ skipInDevelopment: true, isProduction: false }, { APP_ENV: 'development' })).to.eq(true);
    expect(skipsAuthInDevelopment({ skipInDevelopment: 'true', isProduction: false }, { APP_ENV: 'development' })).to.eq(false);
    expect(skipsAuthInDevelopment({ skipInDevelopment: true, isProduction: true }, { APP_ENV: 'development' })).to.eq(false);
    expect(skipsAuthInDevelopment({ skipInDevelopment: true, isProduction: false }, {})).to.eq(false);
  });
});
