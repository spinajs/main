import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';

import { resolveExplainRequest } from '../src/index.js';

describe('resolveExplainRequest', () => {
  it('builds the principal and the resource from <type>:<id> keys', () => {
    const r = resolveExplainRequest({ principal: 'user:alice', permission: 'file:read', resource: 'file:f1' });
    expect(r.principal).to.include({ type: 'user', id: 'alice', authenticated: true, source: 'explain' });
    expect(r.permission).to.eq('file:read');
    expect(r.resource).to.deep.eq({ type: 'file', id: 'f1' });
  });

  it("defaults the resource to the permission's resource type", () => {
    expect(resolveExplainRequest({ principal: 'user:alice', permission: 'file:read' }).resource).to.deep.eq({ type: 'file' });
    expect(resolveExplainRequest({ principal: 'user:alice', permission: 'file:read', resource: '' }).resource).to.deep.eq({ type: 'file' });
  });

  it('unescapes %3A and %25 in the type part only', () => {
    expect(resolveExplainRequest({ principal: 'svc%3Aa%25:x:y', permission: 'file:read' }).principal).to.include({ type: 'svc:a%', id: 'x:y' });
  });

  it('marks anonymous and unattended principals unauthenticated', () => {
    expect(resolveExplainRequest({ principal: 'anonymous:x', permission: 'file:read' }).principal.authenticated).to.eq(false);
    expect(resolveExplainRequest({ principal: 'unattended:x', permission: 'file:read' }).principal.authenticated).to.eq(false);
  });

  it('refuses a principal without an id, an empty part and a malformed permission', () => {
    expect(() => resolveExplainRequest({ principal: 'user', permission: 'file:read' })).to.throw(InvalidArgument, /principal/);
    expect(() => resolveExplainRequest({ principal: 'user:', permission: 'file:read' })).to.throw(InvalidArgument);
    expect(() => resolveExplainRequest({ principal: 'user:a', permission: 'not a permission' })).to.throw(InvalidArgument, /permission/);
  });
});
