import * as chai from 'chai';
import 'mocha';

import { PermissionRegistryImpl } from '../../src/engine/registry.js';
import { AuthzConfigError, PermissionRegistry, UnknownPermission } from '../../src/contracts/index.js';

const expect = chai.expect;

const expectConfigError = (fn: () => unknown, match?: RegExp) => {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected a throw').to.be.instanceOf(AuthzConfigError);
  if (match) {
    expect((caught as Error).message).to.match(match);
  }
  return caught as AuthzConfigError;
};

describe('PermissionRegistryImpl', () => {
  it('is a PermissionRegistry', () => {
    expect(new PermissionRegistryImpl()).to.be.instanceOf(PermissionRegistry);
  });

  describe('register and get', () => {
    it('parses resource and action and defaults types to [resource]', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write' }], 'config');
      const def = reg.get('fs:write');
      expect(def).to.deep.equal({ name: 'fs:write', resource: 'fs', action: 'write', types: ['fs'], source: 'config' });
    });

    it('keeps given types, implies, fields and description', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write', types: ['file', 'folder'], implies: ['fs:stat'], fields: true, description: 'Write files' }], 'model:fs');
      expect(reg.get('fs:write')).to.deep.equal({ name: 'fs:write', resource: 'fs', action: 'write', types: ['file', 'folder'], implies: ['fs:stat'], fields: true, description: 'Write files', source: 'model:fs' });
    });

    it('accepts resource and action that match the name', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write', resource: 'fs', action: 'write' }], 'config');
      expect(reg.get('fs:write')?.resource).to.equal('fs');
    });

    it('stores a frozen copy and does not keep references to the input', () => {
      const reg = new PermissionRegistryImpl();
      const types = ['file'];
      const implies = ['fs:stat'];
      const input = { name: 'fs:write', types, implies };
      reg.register([input], 'config');
      types.push('folder');
      implies.push('fs:list');
      const def = reg.get('fs:write')!;
      expect(Object.isFrozen(def)).to.equal(true);
      expect(Object.isFrozen(def.types)).to.equal(true);
      expect(Object.isFrozen(def.implies)).to.equal(true);
      expect(def.types).to.deep.equal(['file']);
      expect(def.implies).to.deep.equal(['fs:stat']);
      expect(input).to.deep.equal({ name: 'fs:write', types: ['file', 'folder'], implies: ['fs:stat', 'fs:list'] });
    });

    it('dedupes types', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write', types: ['file', 'file', 'folder'] }], 'config');
      expect(reg.get('fs:write')?.types).to.deep.equal(['file', 'folder']);
    });

    it('get returns undefined for an unknown or invalid name', () => {
      const reg = new PermissionRegistryImpl();
      expect(reg.get('fs:write')).to.equal(undefined);
      expect(reg.get('not a name')).to.equal(undefined);
      expect(reg.get('__proto__')).to.equal(undefined);
      expect(reg.get('constructor')).to.equal(undefined);
    });

    it('keeps case: ArrowCampaign:read and arrowcampaign:read are different permissions (H17)', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'ArrowCampaign:read' }], 'config');
      expect(reg.get('ArrowCampaign:read')?.resource).to.equal('ArrowCampaign');
      expect(reg.get('ArrowCampaign:read')?.types).to.deep.equal(['ArrowCampaign']);
      expect(reg.get('arrowcampaign:read')).to.equal(undefined);
      reg.register([{ name: 'arrowcampaign:read' }], 'config');
      expect(reg.all().map((d) => d.name)).to.deep.equal(['ArrowCampaign:read', 'arrowcampaign:read']);
    });

    it('accepts dotted resources such as user.metadata:read', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'user.metadata:read' }], 'config');
      expect(reg.get('user.metadata:read')).to.deep.include({ resource: 'user.metadata', action: 'read', types: ['user.metadata'] });
    });
  });

  describe('register errors', () => {
    it('rejects an invalid name', () => {
      const reg = new PermissionRegistryImpl();
      expectConfigError(() => reg.register([{ name: 'fs' }], 'config'));
      expectConfigError(() => reg.register([{ name: 'fs:*' }], 'config'));
      expectConfigError(() => reg.register([{ name: 1 as unknown as string }], 'config'));
      expect(reg.all()).to.deep.equal([]);
    });

    it('rejects a given resource or action that differs from the name', () => {
      const reg = new PermissionRegistryImpl();
      expectConfigError(() => reg.register([{ name: 'fs:write', resource: 'file' }], 'config'), /fs:write/);
      expectConfigError(() => reg.register([{ name: 'fs:write', action: 'read' }], 'config'), /fs:write/);
    });

    it('rejects empty types and invalid type entries', () => {
      const reg = new PermissionRegistryImpl();
      expectConfigError(() => reg.register([{ name: 'fs:write', types: [] }], 'config'));
      expectConfigError(() => reg.register([{ name: 'fs:write', types: [''] }], 'config'));
      expectConfigError(() => reg.register([{ name: 'fs:write', types: [1 as unknown as string] }], 'config'));
      expectConfigError(() => reg.register([{ name: 'fs:write', types: 'file' as unknown as string[] }], 'config'));
    });

    it('rejects an invalid implies entry', () => {
      const reg = new PermissionRegistryImpl();
      expectConfigError(() => reg.register([{ name: 'fs:write', implies: ['stat'] }], 'config'), /stat/);
      expectConfigError(() => reg.register([{ name: 'fs:write', implies: 'fs:stat' as unknown as string[] }], 'config'));
    });

    it('registers nothing from a batch that holds an invalid def', () => {
      const reg = new PermissionRegistryImpl();
      expectConfigError(() => reg.register([{ name: 'fs:read' }, { name: 'bad' }], 'config'));
      expect(reg.get('fs:read')).to.equal(undefined);
    });

    it('rejects malformed defs, sources, fields and descriptions', () => {
      const reg = new PermissionRegistryImpl();
      expectConfigError(() => reg.register({ name: 'fs:read' } as unknown as [], 'config'));
      expectConfigError(() => reg.register([null as unknown as { name: string }], 'config'));
      expectConfigError(() => reg.register(['fs:read' as unknown as { name: string }], 'config'));
      expectConfigError(() => reg.register([{ name: 'fs:read' }], ''));
      expectConfigError(() => reg.register([{ name: 'fs:read' }], 1 as unknown as string));
      expectConfigError(() => reg.register([{ name: 'fs:read', fields: 'yes' as unknown as boolean }], 'config'));
      expectConfigError(() => reg.register([{ name: 'fs:read', description: 1 as unknown as string }], 'config'));
      expect(reg.all()).to.deep.equal([]);
    });

    it('turns a throwing getter into an AuthzConfigError with cause and registers nothing', () => {
      const reg = new PermissionRegistryImpl();
      const boom = new Error('boom');
      const def = Object.defineProperty({}, 'name', {
        get() {
          throw boom;
        },
      }) as { name: string };
      const err = expectConfigError(() => reg.register([{ name: 'fs:read' }, def], 'config'), /config/);
      expect((err as Error & { cause?: unknown }).cause).to.equal(boom);
      const types = new Proxy(['file'], {
        get() {
          throw boom;
        },
      });
      expectConfigError(() => reg.register([{ name: 'fs:read', types }], 'config'));
      expect(reg.all()).to.deep.equal([]);
    });
  });

  describe('merge', () => {
    it('unions types and implies, ORs fields, keeps the first description, joins sources', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write', types: ['file'], implies: ['fs:stat'], description: '' }], 'config');
      reg.register([{ name: 'fs:write', types: ['folder', 'file'], implies: ['fs:list', 'fs:stat'], fields: true, description: 'Write' }], 'model:fs');
      reg.register([{ name: 'fs:write', fields: false, description: 'Other' }], 'config');
      expect(reg.get('fs:write')).to.deep.equal({
        name: 'fs:write',
        resource: 'fs',
        action: 'write',
        types: ['file', 'folder'],
        implies: ['fs:stat', 'fs:list'],
        fields: true,
        description: 'Write',
        source: 'config,model:fs',
      });
      expect(Object.isFrozen(reg.get('fs:write'))).to.equal(true);
      expect(reg.all()).to.have.length(1);
    });

    it('a registration without types does not add the default [resource] to explicit types', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write', types: ['file', 'dir'] }], 'adapter:fs');
      reg.register([{ name: 'fs:write', fields: true }], 'config');
      expect(reg.get('fs:write')?.types).to.deep.equal(['file', 'dir']);
      expect(reg.types()).to.deep.equal(['dir', 'file']);
    });

    it('explicit types registered later replace the default [resource]', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write' }], 'config');
      expect(reg.get('fs:write')?.types).to.deep.equal(['fs']);
      reg.register([{ name: 'fs:write', types: ['file'] }], 'adapter:fs');
      expect(reg.get('fs:write')?.types).to.deep.equal(['file']);
      expect(reg.types()).to.deep.equal(['file']);
    });

    it('keeps the default [resource] when no registration gives types', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write' }], 'a');
      reg.register([{ name: 'fs:write', fields: true }], 'b');
      expect(reg.get('fs:write')?.types).to.deep.equal(['fs']);
    });

    it('merges a name registered twice in one batch', () => {
      const reg = new PermissionRegistryImpl();
      reg.register(
        [
          { name: 'fs:write', types: ['file'] },
          { name: 'fs:write', types: ['folder'] },
        ],
        'config',
      );
      expect(reg.get('fs:write')?.types).to.deep.equal(['file', 'folder']);
      expect(reg.get('fs:write')?.source).to.equal('config');
    });

    it('keeps fields false when no registration set it true', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write', fields: false }], 'a');
      reg.register([{ name: 'fs:write' }], 'b');
      expect(reg.get('fs:write')?.fields).to.equal(false);
    });
  });

  describe('require', () => {
    it('returns a registered def', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write' }], 'config');
      expect(reg.require('fs:write')).to.equal(reg.get('fs:write'));
    });

    it('throws UnknownPermission (an AuthzConfigError) for an unknown valid name', () => {
      const reg = new PermissionRegistryImpl();
      const err = expectConfigError(() => reg.require('fs:write'), /fs:write/);
      expect(err).to.be.instanceOf(UnknownPermission);
    });

    it('throws a grammar AuthzConfigError, not UnknownPermission, for an invalid name', () => {
      const reg = new PermissionRegistryImpl();
      const err = expectConfigError(() => reg.require('fs'));
      expect(err).to.not.be.instanceOf(UnknownPermission);
    });
  });

  describe('match', () => {
    const reg = new PermissionRegistryImpl();
    reg.register([{ name: 'user:read' }, { name: 'fs:read' }, { name: 'user:write' }, { name: 'user.metadata:read' }, { name: 'user.metadata:write' }], 'config');

    it('matches user:*', () => {
      expect(reg.match('user:*').map((d) => d.name)).to.deep.equal(['user:read', 'user:write']);
    });

    it('matches * in registration order', () => {
      expect(reg.match('*').map((d) => d.name)).to.deep.equal(['user:read', 'fs:read', 'user:write', 'user.metadata:read', 'user.metadata:write']);
    });

    it('matches user.*:read', () => {
      expect(reg.match('user.*:read').map((d) => d.name)).to.deep.equal(['user.metadata:read']);
    });

    it('throws on an invalid glob', () => {
      expectConfigError(() => reg.match('user:**'));
      expectConfigError(() => reg.match('user'));
    });

    it('returns a frozen array', () => {
      expect(Object.isFrozen(reg.match('user:*'))).to.equal(true);
    });
  });

  describe('impliedBy', () => {
    it('finds direct and transitive impliers, sorted, self excluded', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:stat' }, { name: 'fs:write', implies: ['fs:read'] }, { name: 'fs:read', implies: ['fs:stat'] }, { name: 'fs:admin', implies: ['fs:write'] }, { name: 'Fs:root', implies: ['fs:admin'] }, { name: 'fs:other' }], 'config');
      expect(reg.impliedBy('fs:read')).to.deep.equal(['Fs:root', 'fs:admin', 'fs:write']);
      expect(reg.impliedBy('fs:stat')).to.deep.equal(['Fs:root', 'fs:admin', 'fs:read', 'fs:write']);
      expect(reg.impliedBy('fs:other')).to.deep.equal([]);
      expect(reg.impliedBy('fs:unknown')).to.deep.equal([]);
    });

    it('is safe on cycles and excludes self', () => {
      const reg = new PermissionRegistryImpl();
      reg.register(
        [
          { name: 'a:x', implies: ['b:x'] },
          { name: 'b:x', implies: ['a:x'] },
          { name: 'c:x', implies: ['c:x', 'a:x'] },
        ],
        'config',
      );
      expect(reg.impliedBy('a:x')).to.deep.equal(['b:x', 'c:x']);
      expect(reg.impliedBy('b:x')).to.deep.equal(['a:x', 'c:x']);
      expect(reg.impliedBy('c:x')).to.deep.equal([]);
    });

    it('reflects later registrations and returns a frozen array', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:read' }], 'config');
      expect(reg.impliedBy('fs:read')).to.deep.equal([]);
      reg.register([{ name: 'fs:write', implies: ['fs:read'] }], 'config');
      const implied = reg.impliedBy('fs:read');
      expect(implied).to.deep.equal(['fs:write']);
      expect(Object.isFrozen(implied)).to.equal(true);
    });

    it('throws a grammar AuthzConfigError for an invalid name', () => {
      const reg = new PermissionRegistryImpl();
      const err = expectConfigError(() => reg.impliedBy('fs'));
      expect(err).to.not.be.instanceOf(UnknownPermission);
    });
  });

  describe('types', () => {
    it('is the sorted union of all types', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:read', types: ['folder', 'file'] }, { name: 'user:read' }, { name: 'job:run', types: ['job', 'file'] }], 'config');
      expect(reg.types()).to.deep.equal(['file', 'folder', 'job', 'user']);
      expect(Object.isFrozen(reg.types())).to.equal(true);
    });
  });

  describe('all', () => {
    it('lists defs in first registration order', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'b:x' }, { name: 'a:x' }], 'config');
      reg.register([{ name: 'c:x' }, { name: 'b:x', types: ['y'] }], 'config');
      expect(reg.all().map((d) => d.name)).to.deep.equal(['b:x', 'a:x', 'c:x']);
      expect(Object.isFrozen(reg.all())).to.equal(true);
    });
  });

  describe('freeze', () => {
    it('blocks further registration', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:read' }], 'config');
      expect(reg.frozen).to.equal(false);
      reg.freeze();
      expect(reg.frozen).to.equal(true);
      expectConfigError(() => reg.register([{ name: 'fs:write' }], 'config'));
      expect(reg.get('fs:write')).to.equal(undefined);
    });

    it('throws UnknownPermission naming both sides when implies names an unregistered permission', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write', implies: ['fs:stat'] }], 'config');
      const err = expectConfigError(() => reg.freeze(), /fs:write[\s\S]*fs:stat|fs:stat[\s\S]*fs:write/);
      expect(err).to.be.instanceOf(UnknownPermission);
      expect(reg.frozen).to.equal(false);
    });

    it('accepts implies registered later in a separate call', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:write', implies: ['fs:stat'] }], 'config');
      reg.register([{ name: 'fs:stat' }], 'model:fs');
      reg.freeze();
      expect(reg.impliedBy('fs:stat')).to.deep.equal(['fs:write']);
    });

    it('a second freeze does nothing', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'fs:read' }], 'config');
      reg.freeze();
      expect(() => reg.freeze()).to.not.throw();
      expect(reg.frozen).to.equal(true);
      expect(reg.all().map((d) => d.name)).to.deep.equal(['fs:read']);
    });
  });
});
