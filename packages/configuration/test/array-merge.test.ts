import 'mocha';
import { expect } from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike, StaticConfigurationSource } from '@spinajs/configuration-common';

import { COMPOSED_CONFIG_ARRAYS, mergeConfig } from '../src/index.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { BrowserFrameworkConfiguration } from '../src/configuration.browser.js';

const DEFAULTS = {
  http: { socket: { transports: ['polling', 'websocket'] } },
  system: { dirs: { controllers: ['/pkg/controllers'] } },
  fs: { providers: [{ name: 'pkg' }] },
};

const APP = {
  http: { socket: { transports: ['websocket'] } },
  system: { dirs: { controllers: ['/app/controllers'] } },
  fs: { providers: [{ name: 'app' }] },
};

describe('config array merge', () => {
  describe('mergeConfig', () => {
    it('replaces a value array and concatenates a composed one', () => {
      const merged = mergeConfig(structuredClone(DEFAULTS), APP, 'replace');
      expect(merged.http.socket.transports).to.deep.equal(['websocket']);
      expect(merged.system.dirs.controllers).to.deep.equal(['/pkg/controllers', '/app/controllers']);
      expect(merged.fs.providers).to.deep.equal([{ name: 'pkg' }, { name: 'app' }]);
    });

    it('concatenates every array in concat mode', () => {
      const merged = mergeConfig(structuredClone(DEFAULTS), APP, 'concat');
      expect(merged.http.socket.transports).to.deep.equal(['polling', 'websocket', 'websocket']);
    });

    it('keeps the __file__ trail of every section', () => {
      const merged = mergeConfig({ http: { __file__: ['pkg.js'] } }, { http: { __file__: ['app.js'] } }, 'replace');
      expect(merged.http.__file__).to.deep.equal(['pkg.js', 'app.js']);
    });

    it('matches a wildcard segment against one key, dots in the key included', () => {
      const merged = mergeConfig({ authz: { rbac: { roles: { 'admin.users': { grants: ['a'] } } } } }, { authz: { rbac: { roles: { 'admin.users': { grants: ['b'] } } } } }, 'replace');
      expect(merged.authz.rbac.roles['admin.users'].grants).to.deep.equal(['a', 'b']);
    });

    it('copies a replacing array, so changing the result never changes the source', () => {
      const source = { list: [{ a: 1 }] };
      const merged = mergeConfig({ list: [{ a: 0 }] }, source, 'replace');
      merged.list[0].a = 2;
      merged.list.push({ a: 3 });
      expect(source.list).to.deep.equal([{ a: 1 }]);
    });

    it('lists system.dirs as composed', () => {
      expect(COMPOSED_CONFIG_ARRAYS).to.include('system.dirs.*');
    });
  });

  describe('FrameworkConfiguration', () => {
    const booted: IContainer[] = [];

    class Defaults extends ConfigurationSource {
      public get Order() {
        return 0;
      }

      public Load(): Promise<IConfigLike> {
        return Promise.resolve(structuredClone(DEFAULTS) as unknown as IConfigLike);
      }
    }

    async function boot(onLoad: Record<string, unknown>, setup: (c: IContainer) => void = () => undefined) {
      const child = DI.child();
      booted.push(child);
      child.register(Defaults).as(ConfigurationSource);
      const json = JSON.stringify(onLoad);
      child.register(
        class extends FrameworkConfiguration {
          protected onLoad(): unknown {
            return JSON.parse(json) as unknown;
          }
        },
      ).as(Configuration);
      setup(child);
      return (await child.resolve(Configuration)) as FrameworkConfiguration;
    }

    afterEach(async () => {
      for (const c of booted.splice(0).reverse()) await c.dispose();
    });

    it('onLoad() replaces a value array and adds to system.dirs', async () => {
      const config = await boot(APP);
      expect(config.get('http.socket.transports')).to.deep.equal(['websocket']);
      expect(config.get('system.dirs.controllers')).to.deep.equal(['/pkg/controllers', '/app/controllers']);
    });

    it('a later source replaces a value array', async () => {
      const config = await boot({}, (c) => c.register(StaticConfigurationSource(APP, 10)).as(ConfigurationSource));
      expect(config.get('http.socket.transports')).to.deep.equal(['websocket']);
      expect(config.get('fs.providers')).to.deep.equal([{ name: 'pkg' }, { name: 'app' }]);
    });

    it('mergeSource() replaces a value array', async () => {
      const config = await boot({});
      await config.mergeSource(StaticConfigurationSource(APP, 10));
      expect(config.get('http.socket.transports')).to.deep.equal(['websocket']);
      expect(config.get('system.dirs.controllers')).to.deep.equal(['/pkg/controllers', '/app/controllers']);
    });

    it('a __configuration__ value adds to arrays, as a package config does', async () => {
      const config = await boot({}, (c) => c.register({ http: { socket: { transports: ['webtransport'] } } }).asValue('__configuration__'));
      expect(config.get('http.socket.transports')).to.deep.equal(['polling', 'websocket', 'webtransport']);
    });

    it('reloads to the same arrays', async () => {
      const config = await boot(APP);
      await config.load();
      expect(config.get('http.socket.transports')).to.deep.equal(['websocket']);
      expect(config.get('system.dirs.controllers')).to.deep.equal(['/pkg/controllers', '/app/controllers']);
    });
  });

  describe('BrowserFrameworkConfiguration', () => {
    const booted: IContainer[] = [];

    afterEach(async () => {
      for (const c of booted.splice(0).reverse()) await c.dispose();
    });

    it('a later source replaces a value array and adds to system.dirs', async () => {
      const child = DI.child();
      booted.push(child);
      child.register(StaticConfigurationSource(structuredClone(DEFAULTS), 0)).as(ConfigurationSource);
      child.register(StaticConfigurationSource(APP, 10)).as(ConfigurationSource);
      child.register(BrowserFrameworkConfiguration).as(Configuration);
      const config = await child.resolve(Configuration);
      expect(config.get('http.socket.transports')).to.deep.equal(['websocket']);
      expect(config.get('system.dirs.controllers')).to.deep.equal(['/pkg/controllers', '/app/controllers']);

      config.merge('http.socket.transports', ['polling']);
      expect(config.get('http.socket.transports')).to.deep.equal(['websocket', 'polling']);
    });
  });
});
