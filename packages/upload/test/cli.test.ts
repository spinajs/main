import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { DateTime } from 'luxon';
import sinon from 'sinon';

import { UploadSweep } from '../src/cli/UploadSweep.js';
import { UploadSweeper } from '../src/index.js';
import { insertSessionRow, resetUploads, rows, uploadEnv } from './support/env.js';

describe('upload:sweep', () => {
  const log = console.log;
  let printed: string[];

  before(async () => {
    await uploadEnv();
  });
  beforeEach(async () => {
    await resetUploads();
    printed = [];
    console.log = (line: string) => printed.push(line);
  });
  afterEach(() => {
    console.log = log;
    process.exitCode = 0;
    sinon.restore();
  });

  it('sweeps once and prints one line per count', async () => {
    const id = await insertSessionRow({ expires_at: DateTime.utc().minus({ seconds: 1 }) });

    await (await DI.resolve(UploadSweep)).execute();

    expect(printed).to.deep.equal(['1 expired', '0 released', '0 reemitted', '0 purged', '0 removedBlobs', '0 keptBlobs', '0 errors']);
    expect(process.exitCode ?? 0).to.eq(0);
    expect((await rows('upload_sessions', { id }))[0].status).to.eq('expired');
  });

  it('sets exit code 1 when an item failed', async () => {
    sinon.stub(await DI.resolve(UploadSweeper), 'sweep').resolves({ expired: 0, released: 0, reemitted: 0, purged: 0, removedBlobs: 0, keptBlobs: 0, errors: 1 });

    await (await DI.resolve(UploadSweep)).execute();

    expect(printed).to.include('1 errors');
    expect(process.exitCode).to.eq(1);
  });
});
