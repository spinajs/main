import 'mocha';
import { expect } from 'chai';
import { manifestToAsyncApi } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

const options = { title: 'app-basic', version: '1.0.0', serverUrl: 'ws://localhost:4557' };

describe('manifestToAsyncApi and entries only a registration serves', () => {
  it('keeps them out', async () => {
    const manifest = await appBasicManifest();
    expect(Object.keys(manifestToAsyncApi(manifest, options).operations)).to.include('chat.send.send');

    for (const c of manifest.socketControllers) c.mountedBy = 'di';
    expect(Object.keys(manifestToAsyncApi(manifest, options).operations)).to.not.include('chat.send.send');
  });
});
