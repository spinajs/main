import 'mocha';
import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { FileResponse } from '@spinajs/http';
import { ResourceNotFound } from '@spinajs/exceptions';
import { JobsController } from '../src/controllers/JobsControllers.js';
import { JobProgressService } from '../src/services/JobProgressService.js';
import { IJobStatusResponse } from '../src/models/JobEntry.js';

chai.use(chaiAsPromised);

describe('JobsController', function () {
    this.timeout(5000);

    let controller: JobsController;
    let mockService: sinon.SinonStubbedInstance<JobProgressService>;

    const mockJob: IJobStatusResponse = {
        jobId: 'abc-123',
        progress: 75,
        status: 'processing',
        createdAt: new Date().toISOString(),
    };

    beforeEach(() => {
        mockService = sinon.createStubInstance(JobProgressService);
        controller = new JobsController();
        Object.defineProperty(controller, 'Jobs', {
            value: mockService,
            writable: true,
            configurable: true,
        });
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('getStatus()', () => {
        it('should return the job status when job exists', () => {
            mockService.get.returns(mockJob);

            const result = controller.getStatus('abc-123');

            expect(result).to.deep.equal(mockJob);
            expect(mockService.get.calledWith('abc-123')).to.be.true;
        });

        it('should throw NotFound when job does not exist', () => {
            mockService.get.returns(undefined);

            expect(() => controller.getStatus('unknown')).to.throw(ResourceNotFound);
        });
    });

    describe('download()', () => {
        it('should return FileResponse when token is valid', () => {
            mockService.consumeDownloadToken.returns({
                path: '/tmp/offer.pdf',
                provider: 'fs-temp',
                filename: 'oferta.pdf',
                expiresAt: null as any,
            });

            const result = controller.download('abc-123', 'valid-token');

            expect(result).to.be.instanceOf(FileResponse);
            expect((result as any).Options.filename).to.equal('oferta.pdf');
            expect((result as any).Options.deleteAfterDownload).to.be.true;
        });

        it('should throw NotFound when token is invalid or expired', () => {
            mockService.consumeDownloadToken.returns(undefined);

            expect(() => controller.download('abc-123', 'bad-token')).to.throw(ResourceNotFound);
        });
    });
});
