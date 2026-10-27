import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { useTestApp } from '../src/index.js';

describe('useTestApp', () => {
  const app = useTestApp(() => ({ config: { app: { name: 'hooked' } } }));

  it('is created before each test', () => {
    expect(app().config.get('app.name')).to.equal('hooked');
    expect(DI.get(Configuration)).to.equal(app().config);
  });

  it('is a fresh instance per test', () => {
    app().config.set('app.name', 'changed');
    expect(app().config.get('app.name')).to.equal('changed');
  });

  it('did not keep the change of the previous test', () => {
    expect(app().config.get('app.name')).to.equal('hooked');
  });
});

describe('after useTestApp', () => {
  it('root has no Configuration left', () => {
    expect(DI.RootContainer.isResolved(Configuration)).to.be.false;
  });
});

describe('useTestApp getter outside a test', () => {
  // Read at collection time, before any hook of this suite has created an app.
  const getter = useTestApp();
  let thrown: unknown;
  try {
    getter();
  } catch (err) {
    thrown = err;
  }

  it('throws when no app is live', () => {
    expect((thrown as Error | undefined)?.message).to.match(/no app is live/);
  });
});
