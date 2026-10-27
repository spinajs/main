import 'mocha';
import { expect } from 'chai';

import shipped from '../src/config/upload.js';
import { UPLOAD_CONFIGURATION_SCHEMA, UPLOAD_MAX_PART_BYTES } from '../src/index.js';
import { configurationViolations, createTestApp, disposeTestApps } from '@spinajs/testing';

const SCHEMAS = [UPLOAD_CONFIGURATION_SCHEMA];
const bad = (upload: Record<string, unknown>) => configurationViolations({ schemas: SCHEMAS, config: { upload } });

// Spec §6.2, written out.
const DEFAULTS = {
  fs: { temp: 'upload-temp', files: 'upload-files', prefix: 'uploads' },
  limits: { maxFileSize: 1_073_741_824, partSize: 8_388_608, minPartSize: 1_048_576, maxPartSize: 67_108_864, maxParts: 10_000, maxOpenSessionsPerOwner: 20, sessionTtl: '24h' },
  integrity: { partDigest: 'required', fileDigest: 'required' },
  detect: { headBytes: 4100, allowUndetected: ['text/plain', 'text/csv'] },
  assembly: { staleAfter: '30m' },
  sweeper: { every: '15m', retainFinished: '7d', batch: 200 },
};

describe('upload configuration', () => {
  afterEach(disposeTestApps);

  it('fills every default of spec §6.2 when the app configures nothing', async () => {
    const { config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    expect(configuration.get('upload')).to.deep.equal(DEFAULTS);
  });

  it('keeps configured values and fills the rest of their objects', async () => {
    const { config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: { upload: { limits: { partSize: 1_048_576 }, detect: { allowUndetected: ['text/plain'] } } } });
    expect(configuration.get('upload.limits.partSize')).to.eq(1_048_576);
    expect(configuration.get('upload.limits.maxParts')).to.eq(10_000);
    expect(configuration.get('upload.detect')).to.deep.equal({ headBytes: 4100, allowUndetected: ['text/plain'] });
  });

  it('accepts the defaults written out and refuses values the service cannot work with', async () => {
    expect(await bad(DEFAULTS)).to.deep.equal([]);
    expect(await bad({ integrity: { partDigest: 'sometimes' } })).to.include('upload.integrity.partDigest');
    expect(await bad({ integrity: { fileDigest: 'never' } })).to.include('upload.integrity.fileDigest');
    expect(await bad({ limits: { sessionTtl: 'tomorrow' } })).to.include('upload.limits.sessionTtl');
    expect(await bad({ assembly: { staleAfter: '5 minutes' } })).to.include('upload.assembly.staleAfter');
    expect(await bad({ limits: { maxParts: 0 } })).to.include('upload.limits.maxParts');
    expect(await bad({ detect: { headBytes: 0 } })).to.include('upload.detect.headBytes');
    expect(await bad({ detect: { headBytes: 65_536 } })).to.deep.equal([]);
    expect(await bad({ detect: { headBytes: 65_537 } })).to.include('upload.detect.headBytes');
    expect(await bad({ fs: { temp: '' } })).to.include('upload.fs.temp');
    expect(await bad({ fs: { prefix: '../outside' } })).to.include('upload.fs.prefix');
  });

  it('refuses a zero duration where one would expire, go stale or sweep at once, and allows a zero retention', async () => {
    for (const zero of ['0s', '0ms', '0.0h', '00m']) {
      expect(await bad({ limits: { sessionTtl: zero } }), zero).to.include('upload.limits.sessionTtl');
      expect(await bad({ assembly: { staleAfter: zero } }), zero).to.include('upload.assembly.staleAfter');
      expect(await bad({ sweeper: { every: zero } }), zero).to.include('upload.sweeper.every');
    }
    expect(await bad({ limits: { sessionTtl: '0.5s' }, assembly: { staleAfter: '10m' }, sweeper: { every: '1ms', retainFinished: '0s' } })).to.deep.equal([]);
  });

  it('ships the upload alias on the default connection and no upload.* values (they live in the schema)', () => {
    expect(shipped.db).to.deep.equal({ Aliases: { upload: 'default' } });
    expect(shipped).to.not.have.property('upload');
    expect(shipped.queue.connections).to.deep.equal([{ name: 'upload-events', service: 'BlackHoleQueueClient', defaultQueueChannel: 'upload-jobs', defaultTopicChannel: 'upload-events' }]);
  });

  it('ships the CLI scan dir of the upload:sweep command', () => {
    expect(shipped.system.dirs.cli).to.have.length(2);
    for (const dir of shipped.system.dirs.cli) expect(dir.replace(/\\/g, '/')).to.match(/\/node_modules\/@spinajs\/upload\/lib\/cli$/);
  });

  it('caps maxPartSize at UPLOAD_MAX_PART_BYTES, the controller stream limit', async () => {
    expect(UPLOAD_MAX_PART_BYTES).to.eq(5 * 1024 ** 3);
    expect(await bad({ limits: { maxPartSize: UPLOAD_MAX_PART_BYTES } })).to.deep.equal([]);
    expect(await bad({ limits: { maxPartSize: UPLOAD_MAX_PART_BYTES + 1 } })).to.include('upload.limits.maxPartSize');
  });
});
