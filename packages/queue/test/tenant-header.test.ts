import 'mocha';
import { expect } from 'chai';
import { QueueHeaders, readQueueHeaders, withoutTransportHeaders } from '../src/headers.js';

describe('the tenant header', () => {
  it('is a standard header', () => {
    expect(QueueHeaders.Tenant).to.equal('x-spinajs-tenant');
  });

  it('is read back from broker headers, which keep standard names only', () => {
    expect(readQueueHeaders({ 'x-spinajs-tenant': 'acme', 'x-app': 'not standard' })).to.deep.equal({ 'x-spinajs-tenant': 'acme' });
  });

  it('survives a re-emit, which drops only what a transport writes', () => {
    expect(withoutTransportHeaders({ 'x-spinajs-tenant': 'acme', 'x-retry-count': '2', 'x-error': 'boom' })).to.deep.equal({ 'x-spinajs-tenant': 'acme' });
  });
});
