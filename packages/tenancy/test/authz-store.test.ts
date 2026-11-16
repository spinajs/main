import 'mocha';
import { expect } from 'chai';
import { SYSTEM, currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import { currentTenant, runInTenant } from '../src/index.js';

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
});
