import 'mocha';
import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { ResourceNotFound } from '@spinajs/exceptions';
import { JobsController } from '../src/controllers/JobsControllers.js';
import { JobProgressService } from '../src/services/JobProgressService.js';
import { IJobStatusResponse } from '../src/models/JobEntry.js';
import { DateTime } from 'luxon';

chai.use(chaiAsPromised);

describe('JobsController', function () {
    this.timeout(5000);

    let controller: JobsController;
    let mockService: sinon.SinonStubbedInstance<JobProgressService>;

    const mockJob: IJobStatusResponse = {
        jobId: 'abc-123',
        progress: 75,
        status: 'processing',
        createdAt: DateTime.now(),
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

        it('should throw ResourceNotFound when job does not exist', () => {
            mockService.get.returns(undefined);

            expect(() => controller.getStatus('unknown')).to.throw(ResourceNotFound);
        });
    });
});

