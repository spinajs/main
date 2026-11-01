import 'mocha';
import { expect } from 'chai';
import { generateClient } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

describe('generateClient and entries only a registration serves', () => {
  it('keeps them out', async () => {
    const manifest = await appBasicManifest();
    expect(await generateClient({ manifest })).to.match(/health/i);

    for (const c of manifest.controllers) if (c.className === 'HealthController') c.mountedBy = 'di';
    for (const c of manifest.socketControllers) c.mountedBy = 'di';
    const source = await generateClient({ manifest });
    expect(source).to.not.match(/health/i);
    expect(source).to.not.include('chat.send');
  });
});
