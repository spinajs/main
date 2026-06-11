import 'mocha';
import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DateTime } from 'luxon';
import { JobProgressService } from '../src/services/JobProgressService.js';

chai.use(chaiAsPromised);

describe('JobProgressService', function () {
    this.timeout(5000);

    let service: JobProgressService;

    beforeEach(() => {
        service = new JobProgressService();
        // Prevent GC interval from being created in unit tests
        sinon.stub(globalThis, 'setInterval').returns(undefined as any);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('create()', () => {
        it('should return a UUID string', () => {
            const jobId = service.create();
            expect(jobId).to.be.a('string');
            expect(jobId).to.match(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            );
        });

        it('should create a job with pending status and 0 progress', () => {
            const jobId = service.create();
            const job = service.get(jobId);
            expect(job).to.not.be.undefined;
            expect(job!.status).to.equal('pending');
            expect(job!.progress).to.equal(0);
        });

        it('should set createdAt as ISO string', () => {
            const jobId = service.create();
            const job = service.get(jobId);
            expect(DateTime.fromISO(job!.createdAt).isValid).to.be.true;
        });
    });

    describe('update()', () => {
        it('should change status to processing', () => {
            const jobId = service.create();
            service.update(jobId, 50);
            expect(service.get(jobId)!.status).to.equal('processing');
        });

        it('should set progress to given value', () => {
            const jobId = service.create();
            service.update(jobId, 42);
            expect(service.get(jobId)!.progress).to.equal(42);
        });

        it('should clamp progress to 0-100', () => {
            const jobId = service.create();
            service.update(jobId, -10);
            expect(service.get(jobId)!.progress).to.equal(0);
            service.update(jobId, 150);
            expect(service.get(jobId)!.progress).to.equal(100);
        });

        it('should set message when provided', () => {
            const jobId = service.create();
            service.update(jobId, 30, 'Parsing XLSX');
            expect(service.get(jobId)!.message).to.equal('Parsing XLSX');
        });

        it('should throw for unknown jobId', () => {
            expect(() => service.update('non-existent', 50)).to.throw();
        });
    });

    describe('complete()', () => {
        it('should set progress to 100 and status to done', () => {
            const jobId = service.create();
            service.complete(jobId);
            const job = service.get(jobId)!;
            expect(job.progress).to.equal(100);
            expect(job.status).to.equal('done');
        });

        it('should store downloadToken when provided', () => {
            const jobId = service.create();
            service.complete(jobId, 'my-token');
            expect(service.get(jobId)!.downloadToken).to.equal('my-token');
        });

        it('should not set downloadToken when not provided', () => {
            const jobId = service.create();
            service.complete(jobId);
            expect(service.get(jobId)!.downloadToken).to.be.undefined;
        });
    });

    describe('fail()', () => {
        it('should set status to error and store error message', () => {
            const jobId = service.create();
            service.fail(jobId, new Error('Something went wrong'));
            const job = service.get(jobId)!;
            expect(job.status).to.equal('error');
            expect(job.error).to.equal('Something went wrong');
        });
    });

    describe('get()', () => {
        it('should return undefined for unknown jobId', () => {
            expect(service.get('unknown')).to.be.undefined;
        });

        it('should not expose _expiresAt in returned object', () => {
            const jobId = service.create();
            const job = service.get(jobId) as any;
            expect(job._expiresAt).to.be.undefined;
        });
    });

    describe('download tokens', () => {
        it('createDownloadToken() should return a UUID string', () => {
            const token = service.createDownloadToken('/tmp/file.pdf', 'fs-temp', 'offer.pdf');
            expect(token).to.match(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            );
        });

        it('consumeDownloadToken() should return the entry on first call', () => {
            const token = service.createDownloadToken('/tmp/file.pdf', 'fs-temp', 'offer.pdf');
            const entry = service.consumeDownloadToken(token);
            expect(entry).to.not.be.undefined;
            expect(entry!.path).to.equal('/tmp/file.pdf');
            expect(entry!.provider).to.equal('fs-temp');
            expect(entry!.filename).to.equal('offer.pdf');
        });

        it('consumeDownloadToken() should return undefined on second call (one-time use)', () => {
            const token = service.createDownloadToken('/tmp/file.pdf', 'fs-temp', 'offer.pdf');
            service.consumeDownloadToken(token);
            expect(service.consumeDownloadToken(token)).to.be.undefined;
        });

        it('consumeDownloadToken() should return undefined for unknown token', () => {
            expect(service.consumeDownloadToken('unknown-token')).to.be.undefined;
        });

        it('consumeDownloadToken() should return undefined for expired token', () => {
            const token = service.createDownloadToken('/tmp/file.pdf', 'fs-temp', 'offer.pdf');
            // Manually expire the token
            const downloads = (service as any)._downloads as Map<string, { expiresAt: DateTime }>;
            downloads.get(token)!.expiresAt = DateTime.now().minus({ minutes: 1 });
            expect(service.consumeDownloadToken(token)).to.be.undefined;
        });
    });

    describe('_gc()', () => {
        it('should remove expired jobs', () => {
            const jobId = service.create();
            // Manually expire the job
            const jobs = (service as any)._jobs as Map<string, { _expiresAt: DateTime }>;
            jobs.get(jobId)!._expiresAt = DateTime.now().minus({ minutes: 1 });

            (service as any)._gc();

            expect(service.get(jobId)).to.be.undefined;
        });

        it('should keep non-expired jobs', () => {
            const jobId = service.create();
            (service as any)._gc();
            expect(service.get(jobId)).to.not.be.undefined;
        });
    });
});
