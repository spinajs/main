# `@spinajs/testing`

Boots a SpinaJS application for one test or one suite and puts the DI container back afterwards, so suites in one mocha process do not see each other's registrations, singletons or configuration.

## Install

```sh
npm install --save-dev @spinajs/testing
```

## Features

| Feature | What it does |
| --- | --- |
| [createTestApp](01-create-test-app.md) | Boot a Configuration from an object or a class, run bootstrappers, resolve services, dispose; `useTestApp` for mocha; root and child scopes; configuration helpers. |

## Quick start

```ts sample
import { useTestApp } from '@spinajs/testing';
import { expect } from 'chai';

describe('my service', () => {
  const app = useTestApp({ config: { app: { name: 'spec' } } });

  it('reads configuration', () => {
    expect(app().config.get('app.name')).to.equal('spec');
  });
});
```
