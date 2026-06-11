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
        sinon.stub(globalThis, 'setInterval').returns(undefined as any);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('create()', () => {
        it('should return a UUID string when no jobId provided', () => {
            const jobId = service.create();
            expect(jobId).to.be.a('string');
            expect(jobId).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        });

        it('should use provided jobId', () => {
            const jobId = service.create('my-custom-id');
            expect(jobId).to.equal('my-custom-id');
            expect(service.get('my-custom-id')).to.not.be.undefined;
        });

        it('should create a job with pending status and 0 progress', () => {
            const jobId = service.create();
            const job = service.get(jobId);
            expect(job).to.not.be.undefined;
            expect(job!.status).to.equal('pending');
            expect(job!.progress).to.equal(0);
        });

        it('should set createdAt as DateTime', () => {
            const jobId = service.create();
            const job = service.get(jobId);
            expect(job!.createdAt).to.be.instanceOf(DateTime);
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

        it('should throw for unknown jobId', () => {
            expect(() => service.complete('non-existent')).to.throw();
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

        it('should throw for unknown jobId', () => {
            expect(() => service.fail('non-existent', new Error('x'))).to.throw();
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

    describe('_gc()', () => {
        it('should remove expired jobs', () => {
            const jobId = service.create();
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
