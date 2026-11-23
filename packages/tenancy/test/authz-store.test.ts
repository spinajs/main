import 'mocha';
import { expect } from 'chai';
import { SYSTEM, currentPrincipal, requestScope, runWithPrincipal } from '@spinajs/authz';
import { currentTenant, runAcrossTenants, runInTenant } from '../src/index.js';

function authzCache(): Map<string, unknown> {
  const cache = requestScope().cache;
  if (cache === undefined) throw new Error('authz gave no request cache');
  return cache;
}

describe('tenant scope and the authz principal share one store', () => {
  it('keeps the tenant when authz switches the principal', async () => {
    const seen = await runInTenant('acme', () => runWithPrincipal(SYSTEM, async () => ({ tenant: currentTenant()?.id, principal: currentPrincipal() })));

    expect(seen.tenant).to.eq('acme');
    expect(seen.principal).to.eq(SYSTEM);
  });

  it('keeps the principal when the tenant is entered', async () => {
    const seen = await runWithPrincipal(SYSTEM, () => runInTenant('acme', async () => ({ tenant: currentTenant()?.id, principal: currentPrincipal() })));

    expect(seen.tenant).to.eq('acme');
    expect(seen.principal).to.eq(SYSTEM);
  });

  it('gives every new scope its own authz request cache', async () => {
    const seen = await runWithPrincipal(SYSTEM, async () => {
      const outer = authzCache();
      outer.set('outer', true);

      const inAcme = await runInTenant('acme', async () => {
        const cache = authzCache();
        cache.set('acme', true);
        const reentered = await runInTenant('acme', async () => authzCache());
        return { cache, reentered, hasOuter: cache.has('outer') };
      });
      const inGlobex = await runInTenant('globex', async () => authzCache());
      const acrossAll = await runAcrossTenants('nightly billing', async () => authzCache());

      return { outer, inAcme, inGlobex, acrossAll, outerAfter: authzCache() };
    });

    expect(seen.inAcme.cache).to.not.eq(seen.outer);
    expect(seen.inAcme.hasOuter).to.eq(false);
    expect(seen.inAcme.reentered).to.eq(seen.inAcme.cache);
    expect(seen.inGlobex).to.not.eq(seen.outer);
    expect(seen.inGlobex.has('acme')).to.eq(false);
    expect(seen.acrossAll).to.not.eq(seen.outer);
    expect(seen.outerAfter).to.eq(seen.outer);
    expect([...seen.outer.keys()]).to.deep.eq(['outer']);
  });
});
