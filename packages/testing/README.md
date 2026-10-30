# `@spinajs/testing`

Boots a SpinaJS application for one test or one suite and puts the DI container back afterwards, so suites in one mocha process do not see each other's registrations, singletons or configuration.

```ts
import { useTestApp } from '@spinajs/testing';
import { expect } from 'chai';

describe('my service', () => {
  const app = useTestApp({ config: { app: { name: 'spec' } } });

  it('reads configuration', () => {
    expect(app().config.get('app.name')).to.equal('spec');
  });
});
```

- `createTestApp(options)` boots a Configuration from an object or a class, runs bootstrappers, resolves services, and returns a `TestApp` whose `dispose()` undoes it.
- `scope: 'root'` (default) snapshots and restores the root container, for code that uses the static `DI` API; one root app at a time. `scope: 'child'` boots in an isolating child container; several can be live at once.
- `useTestApp(options)` creates a fresh app before each mocha test and disposes it after.
- `disposeTestApps()` disposes every live app in reverse creation order.
- Configuration helpers: `configurationViolations`, `readingFrom`, `fakeContainer`, `setPastSchema`.

Options and details: [docs/testing](../../docs/testing/README.md).
