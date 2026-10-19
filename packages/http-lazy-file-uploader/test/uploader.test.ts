import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { FsBootsrapper } from '@spinajs/fs';
import { HttpLazyFileUploader, LazyUploadJob } from '../src/index.js';
import config from '../src/config/HttpLazyFileUploader.js';

chai.use(chaiAsPromised);

describe('HttpLazyFileUploader', () => {
  afterEach(() => sinon.restore());

  it('queues each route to its own target filesystem', async () => {
    const emit = sinon.stub(LazyUploadJob, 'emit').resolves('job-id');
    const file = { BaseName: 'f.txt', Provider: { Name: 'tmp' } } as any;

    await DI.resolve(HttpLazyFileUploader, [{ fs: 'invoices' }]).upload(file);
    await DI.resolve(HttpLazyFileUploader, [{ fs: 'avatars' }]).upload(file);

    expect(emit.firstCall.args[0].ToFilesystem).to.eq('invoices');
    expect(emit.secondCall.args[0].ToFilesystem).to.eq('avatars');
  });

  it('ships a queue route for the job', () => {
    expect(config.queue.routing).to.have.property(LazyUploadJob.name);
  });
});

describe('LazyUploadJob', () => {
  it('fails with IOFail for a filesystem that is not configured', async () => {
    new FsBootsrapper().bootstrap();
    const job = new LazyUploadJob();
    Object.assign(job, { SourceFilesystem: 'not-configured', ToFilesystem: 'not-configured', Path: 'f.txt' });
    Object.defineProperty(job, 'Log', { value: { info: () => {} } });

    await expect(job.execute(async () => {})).to.be.rejectedWith(IOFail);
  });
});
