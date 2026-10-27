# `@spinajs/testing`

Boots a SpinaJS application for one test or one suite and puts the DI container back afterwards.

```ts
import { createTestApp } from '@spinajs/testing';

const app = await createTestApp({ config: { app: { name: 'spec' } } });
expect(app.config.get('app.name')).to.equal('spec');
await app.dispose();
```

See `docs/testing/README.md`.
