import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import * as root from '../../src/index.js';
import { AuthzConfigError, UnknownPermission } from '../../src/contracts/errors.js';
import { PERMISSION_GLOB_PATTERN, PERMISSION_PATTERN, PermissionRegistry, compilePermissionGlob, isPermission, isPermissionGlob, matchesPermission, parsePermission } from '../../src/contracts/permission.js';
import type { Permission, PermissionDef } from '../../src/index.js';

const expect = chai.expect;

const VALID = ['user.metadata:read', 'ArrowCampaign:read', 'fs:write', 'a-b_c.d:e.f-g'];
const INVALID = ['user', ':read', 'user:', '1user:read', 'user:1read', 'user:read:x', 'user read', 'user:*', '*', ' user:read', 'user:read\n', 'ąę:read', ''];

const part = (unit: fc.Arbitrary<string>, rest: fc.Arbitrary<string>) => fc.tuple(unit, fc.string({ unit: rest, maxLength: 4 })).map(([a, b]) => a + b);
const nameOf = (first: fc.Arbitrary<string>, rest: fc.Arbitrary<string>) => fc.tuple(part(first, rest), part(first, rest)).map(([r, a]) => `${r}:${a}`);
// The small alphabet makes equal and near-equal pairs common.
const smallName = nameOf(fc.constantFrom('a', 'B'), fc.constantFrom('a', 'B', '.', '-', '_', '1'));
const anyName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_.-]*:[A-Za-z][A-Za-z0-9_.-]*$/);

describe('permission contracts', () => {
  describe('errors', () => {
    it('UnknownPermission is an AuthzConfigError and an Error', () => {
      const err = new UnknownPermission('fs:write');

      expect(err).to.be.instanceOf(UnknownPermission);
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err).to.be.instanceOf(Error);
      expect(err.name).to.eq('UnknownPermission');
      expect(err.message).to.eq('fs:write');
      expect(new AuthzConfigError('x').name).to.eq('AuthzConfigError');
      expect(new AuthzConfigError('x')).to.not.be.instanceOf(UnknownPermission);
    });

    it('is exported from the package root', () => {
      expect(root.AuthzConfigError).to.eq(AuthzConfigError);
      expect(root.UnknownPermission).to.eq(UnknownPermission);
      expect(root.parsePermission).to.eq(parsePermission);
      expect(root.matchesPermission).to.eq(matchesPermission);
      expect(root.PermissionRegistry).to.eq(PermissionRegistry);
    });
  });

  describe('names', () => {
    it('accepts valid names and parses them with case kept', () => {
      for (const name of VALID) {
        expect(isPermission(name), name).to.eq(true);
        expect(PERMISSION_PATTERN.test(name), name).to.eq(true);
      }

      expect(parsePermission('user.metadata:read')).to.deep.eq({ resource: 'user.metadata', action: 'read' });
      expect(parsePermission('ArrowCampaign:read')).to.deep.eq({ resource: 'ArrowCampaign', action: 'read' });
      expect(parsePermission('fs:write')).to.deep.eq({ resource: 'fs', action: 'write' });
      expect(parsePermission('a-b_c.d:e.f-g')).to.deep.eq({ resource: 'a-b_c.d', action: 'e.f-g' });
    });

    it('compares case exactly', () => {
      expect(parsePermission('ArrowCampaign:read')).to.not.deep.eq(parsePermission('arrowcampaign:read'));
      expect(matchesPermission('ArrowCampaign:read', 'arrowcampaign:read')).to.eq(false);
      expect(matchesPermission('arrowcampaign:*', 'ArrowCampaign:read')).to.eq(false);
    });

    it('rejects invalid names', () => {
      for (const name of INVALID) {
        expect(isPermission(name), JSON.stringify(name)).to.eq(false);
        expect(PERMISSION_PATTERN.test(name), JSON.stringify(name)).to.eq(false);
        expect(() => parsePermission(name), JSON.stringify(name)).to.throw(AuthzConfigError);
      }
    });

    it('names the bad value in the parse error', () => {
      expect(() => parsePermission('user:1read')).to.throw(AuthzConfigError, 'user:1read');
      expect(() => parsePermission('')).to.throw(AuthzConfigError, '""');
    });

    it('isPermission is false for non-strings', () => {
      for (const value of [undefined, null, 1, true, {}, [], ['fs:write'], new String('fs:write'), Symbol('fs:write')]) {
        expect(isPermission(value), String(value)).to.eq(false);
      }
    });

    it('exports anchored patterns without flags', () => {
      expect(PERMISSION_PATTERN.flags).to.eq('');
      expect(PERMISSION_GLOB_PATTERN.flags).to.eq('');
      expect(PERMISSION_PATTERN.source.startsWith('^')).to.eq(true);
      expect(PERMISSION_PATTERN.source.endsWith('$')).to.eq(true);
      expect(PERMISSION_GLOB_PATTERN.source.startsWith('^')).to.eq(true);
      expect(PERMISSION_GLOB_PATTERN.source.endsWith('$')).to.eq(true);
      expect(Object.isFrozen(PERMISSION_PATTERN)).to.eq(true);
      expect(Object.isFrozen(PERMISSION_GLOB_PATTERN)).to.eq(true);
    });

    it('returns a frozen parse result', () => {
      expect(Object.isFrozen(parsePermission('fs:write'))).to.eq(true);
    });
  });

  describe('globs', () => {
    const cases: Array<[string, Permission, boolean]> = [
      ['user:*', 'user:read', true],
      ['user:*', 'user.metadata:read', false],
      ['user.*:read', 'user.metadata:read', true],
      ['user.*:read', 'user.a.b:read', true],
      ['user.*:read', 'user:read', false],
      ['user.*:read', 'userX:read', false],
      ['a.b:c', 'aXb:c', false],
      ['a.b:c', 'a.b:c', true],
      ['*:read', 'user:read', true],
      ['*:read', 'user.metadata:read', true],
      ['*:read', 'user:write', false],
      ['*:read', 'user:readX', false],
      ['*', 'user:read', true],
      ['*', 'ArrowCampaign:read', true],
      ['*:*', 'a-b_c.d:e.f-g', true],
      ['user*:read', 'user:read', true],
      ['user*:read', 'users:read', true],
      ['us*er:read', 'user:read', true],
      ['us*er:read', 'us.x.er:read', true],
      ['us*er:read', 'user.x:read', false],
      ['user:re*', 'user:read', true],
      ['user:re*', 'user:write', false],
      ['fs:write', 'fs:write', true],
      ['fs:write', 'fs:writeX', false],
      ['fs:write', 'fs:wri', false],
      ['f-s:w_r.i', 'f-s:w_r.i', true],
      ['*.*:read', 'user.metadata:read', true],
      ['*.*:read', 'user:read', false],
      ['*a*b*:c', 'xaybz:c', true],
      ['*a*b*:c', 'xbyaz:c', false],
      ['a*a:b', 'a:b', false],
      ['a*a:b', 'aa:b', true],
    ];

    it('matches as specified', () => {
      for (const [glob, name, expected] of cases) {
        expect(isPermissionGlob(glob), glob).to.eq(true);
        expect(PERMISSION_GLOB_PATTERN.test(glob), glob).to.eq(true);
        expect(matchesPermission(glob, name), `${glob} ~ ${name}`).to.eq(expected);
        expect(compilePermissionGlob(glob)(name), `compiled ${glob} ~ ${name}`).to.eq(expected);
      }
    });

    it('throws for a name that is not a valid permission, also under *', () => {
      for (const glob of ['*', '*:*', 'a:*', 'a:b', 'a*:c']) {
        const matches = compilePermissionGlob(glob);
        for (const name of ['garbage', 'a:b:c', ':', 'a:', '1a:b', 'a:b\n', '']) {
          expect(() => matchesPermission(glob, name), `${glob} ~ ${JSON.stringify(name)}`).to.throw(AuthzConfigError);
          expect(() => matches(name), `compiled ${glob} ~ ${JSON.stringify(name)}`).to.throw(AuthzConfigError);
        }
        expect(() => matches(undefined as unknown as Permission)).to.throw(AuthzConfigError);
      }
      expect(() => matchesPermission('*', 'garbage')).to.throw(AuthzConfigError, 'garbage');
    });

    it('rejects invalid globs by throwing, never by a silent false', () => {
      for (const glob of ['user:', 'us er:*', '**:', ':*', 'a:b:c', '', 'user', 'user*', 'user:re ad', 'ąę:*', 'user:*\n', ' *', '* ', 'a:b?', 'a:(b)', 'a:[b]']) {
        expect(isPermissionGlob(glob), JSON.stringify(glob)).to.eq(false);
        expect(PERMISSION_GLOB_PATTERN.test(glob), JSON.stringify(glob)).to.eq(false);
        expect(() => matchesPermission(glob, 'user:read'), JSON.stringify(glob)).to.throw(AuthzConfigError);
        expect(() => compilePermissionGlob(glob), JSON.stringify(glob)).to.throw(AuthzConfigError);
      }
      expect(() => matchesPermission('us er:*', 'user:read')).to.throw(AuthzConfigError, 'us er:*');
    });

    it('rejects runs of adjacent stars', () => {
      for (const glob of ['**', '***', '**:read', 'user:**', 'a**b:c', 'a:b**', '*:**', '**:*', 'a***:b']) {
        expect(isPermissionGlob(glob), glob).to.eq(false);
        expect(PERMISSION_GLOB_PATTERN.test(glob), glob).to.eq(false);
        expect(() => matchesPermission(glob, 'user:read'), glob).to.throw(AuthzConfigError);
        expect(() => compilePermissionGlob(glob), glob).to.throw(AuthzConfigError);
      }
    });

    it('matches in linear time, whatever the glob', function () {
      this.timeout(1000);
      const name = `${'a'.repeat(200)}:${'a'.repeat(200)}`;
      const spaced = `${'a*'.repeat(30)}c`;
      const hostile = [`${spaced}:x`, `*:${spaced}`, `${spaced}:${spaced}`, `${'*a'.repeat(60)}b:*`];

      for (const glob of hostile) {
        const start = performance.now();
        expect(matchesPermission(glob, name), glob).to.eq(false);
        expect(performance.now() - start, glob).to.be.below(50);
      }

      const start = performance.now();
      expect(() => matchesPermission(`${'*'.repeat(64)}:write`, 'organization.members:read')).to.throw(AuthzConfigError);
      expect(isPermissionGlob(`${'*'.repeat(10000)}:write`)).to.eq(false);
      expect(isPermissionGlob(`${'a*'.repeat(10000)}:${'*a'.repeat(10000)}`)).to.eq(true);
      expect(performance.now() - start).to.be.below(50);
    });

    it('agrees with a regex reference on small inputs', () => {
      const globPart = fc
        .array(fc.constantFrom('a', 'B', '.', '*'), { minLength: 1, maxLength: 6 })
        .map((units) => units.join(''))
        .filter((part) => !part.includes('**'));
      const glob = fc.oneof(
        fc.constant('*'),
        fc.tuple(globPart, globPart).map(([r, a]) => `${r}:${a}`),
      );
      const reference = (g: string, n: string) => g === '*' || new RegExp(`^${g.replace(/\./g, '\\.').replace(/\*/g, '[^:]*')}$`).test(n);

      fc.assert(
        fc.property(glob, smallName, (g, n) => matchesPermission(g, n) === reference(g, n)),
        { numRuns: 5000 },
      );
    });

    it('isPermissionGlob is false for non-strings', () => {
      for (const value of [undefined, null, 1, {}, ['*'], new String('*')]) {
        expect(isPermissionGlob(value), String(value)).to.eq(false);
      }
    });

    it('treats every valid name as a glob that matches only itself', () => {
      for (const n of [smallName, anyName]) {
        fc.assert(
          fc.property(n, (name) => isPermissionGlob(name) && matchesPermission(name, name) && matchesPermission('*', name) && matchesPermission('*:*', name)),
          { numRuns: 1000 },
        );
        fc.assert(
          fc.property(n, n, (a, b) => matchesPermission(a, b) === (a === b)),
          { numRuns: 2000 },
        );
      }
    });

    it('matches a resource-wide or action-wide glob by the exact part', () => {
      fc.assert(
        fc.property(smallName, smallName, (a, b) => {
          const pa = parsePermission(a);
          const pb = parsePermission(b);

          return matchesPermission(`${pa.resource}:*`, b) === (pa.resource === pb.resource) && matchesPermission(`*:${pa.action}`, b) === (pa.action === pb.action);
        }),
        { numRuns: 2000 },
      );
    });
  });

  describe('PermissionRegistry', () => {
    class MemoryRegistry extends PermissionRegistry {
      constructor(private readonly defs: readonly PermissionDef[]) {
        super();
      }

      get(name: Permission): PermissionDef | undefined {
        return this.defs.find((d) => d.name === name);
      }

      require(name: Permission): PermissionDef {
        const def = this.get(name);
        if (!def) throw new UnknownPermission(name);
        return def;
      }

      match(glob: string): readonly PermissionDef[] {
        const matches = compilePermissionGlob(glob);
        return this.defs.filter((d) => matches(d.name));
      }

      impliedBy(name: Permission): readonly Permission[] {
        return this.defs.filter((d) => d.implies?.includes(name)).map((d) => d.name);
      }

      all(): readonly PermissionDef[] {
        return this.defs;
      }
    }

    const write: PermissionDef = { name: 'fs:write', resource: 'fs', action: 'write', types: ['fs'], implies: ['fs:stat'], fields: false, description: 'write files', source: 'config' };
    const stat: PermissionDef = { name: 'fs:stat', resource: 'fs', action: 'stat', types: ['fs', 'dir'], source: 'adapter:fs' };

    it('can be implemented by an in-memory fake', () => {
      const registry: PermissionRegistry = new MemoryRegistry([write, stat]);

      expect(registry.get('fs:write')).to.eq(write);
      expect(registry.get('fs:read')).to.eq(undefined);
      expect(registry.require('fs:stat')).to.eq(stat);
      expect(() => registry.require('fs:read')).to.throw(UnknownPermission);
      expect(registry.match('fs:*')).to.deep.eq([write, stat]);
      expect(registry.impliedBy('fs:stat')).to.deep.eq(['fs:write']);
      expect(registry.all()).to.have.length(2);
    });

    it('types PermissionDef as the design writes it', () => {
      // @ts-expect-error source is required
      const noSource: PermissionDef = { name: 'fs:write', resource: 'fs', action: 'write', types: ['fs'] };
      // @ts-expect-error types is required
      const noTypes: PermissionDef = { name: 'fs:write', resource: 'fs', action: 'write', source: 'config' };
      // @ts-expect-error fields is a boolean
      const badFields: PermissionDef = { ...stat, fields: ['a'] };
      // Never called: the statements only have to fail to compile.
      const rejected = (def: PermissionDef) => {
        // @ts-expect-error name is readonly
        def.name = 'fs:read';
        // @ts-expect-error types is a readonly array
        def.types.push('file');
        // @ts-expect-error an abstract class cannot be instantiated
        return new PermissionRegistry();
      };

      expect([noSource, noTypes, badFields, rejected]).to.have.length(4);
    });
  });
});
