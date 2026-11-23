import 'mocha';
import { expect } from 'chai';
import { SpinaAttr } from '../src/index.js';

describe('SpinaAttr', () => {
  it('names the tenant attribute', () => {
    expect(SpinaAttr.Tenant).to.eq('spina.tenant.id');
  });
});
