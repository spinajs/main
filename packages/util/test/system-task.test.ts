import { expect } from 'chai';
import 'mocha';
import { SystemTask, systemTaskOf } from '../src/index.js';

describe('@SystemTask', () => {
  it('records the reason on the class itself', () => {
    @SystemTask('nightly sweep over all tenants')
    class Sweep {}
    class Narrower extends Sweep {}

    expect(systemTaskOf(Sweep)).to.equal('nightly sweep over all tenants');
    expect(systemTaskOf(Narrower)).to.equal(undefined);
    expect(systemTaskOf(class Plain {})).to.equal(undefined);
  });

  it('refuses an empty reason', () => {
    expect(() => SystemTask('  ')).to.throw('@SystemTask needs a reason');
    expect(() => SystemTask(undefined as unknown as string)).to.throw('@SystemTask needs a reason');
  });
});
