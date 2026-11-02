import 'mocha';
import { expect } from 'chai';
import { PROBLEM_DETAILS_SCHEMA } from '@spinajs/http';
import { manifestToOpenApi } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

const options = { title: 'app-basic', version: '1.0.0', errorSchema: PROBLEM_DETAILS_SCHEMA };

describe('manifestToOpenApi and entries only a registration serves', () => {
  it('keeps them out: nothing static can tell that the registration runs', async () => {
    const manifest = await appBasicManifest();
    const before = manifestToOpenApi(manifest, options);
    expect(Object.keys(before.paths ?? {}).some((p) => p.includes('health'))).to.equal(true);

    for (const c of manifest.controllers) if (c.className === 'HealthController') c.mountedBy = 'di';
    const doc = manifestToOpenApi(manifest, options);
    expect(Object.keys(doc.paths ?? {}).some((p) => p.includes('health'))).to.equal(false);
    expect((doc.tags ?? []).map((t) => t.name)).to.not.include('Health');
  });
});
