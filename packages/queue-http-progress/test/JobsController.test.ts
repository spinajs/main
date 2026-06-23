import 'mocha';
import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { JobsController } from '../src/controllers/JobsControllers.js';
import { IJobStatusResponse } from '../src/models/JobEntry.js';
import { DateTime } from 'luxon';
import { JobModel } from '@spinajs/queue';
import { Ok } from '@spinajs/http';

chai.use(chaiAsPromised);

describe('JobsController', function () {
    this.timeout(5000);

    let controller: JobsController;

    const mockJobRow = {
        JobId: 'abc-123',
        Progress: 75,
        Status: 'executing' as const,
        Result: null,
        CreatedAt: DateTime.now(),
    };

    beforeEach(() => {
        controller = new JobsController();
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('getStatus()', () => {
        it('should return Ok with job status when job exists', async () => {
            const queryBuilder = {
                where: sinon.stub().returnsThis(),
                firstOrFail: sinon.stub().resolves(mockJobRow),
            };
            sinon.stub(JobModel, 'select').returns(queryBuilder as any);

            const result = await controller.getStatus('abc-123');

            expect(result).to.be.instanceOf(Ok);
            const response = (result as any).responseData as IJobStatusResponse;
            expect(response.jobId).to.equal('abc-123');
            expect(response.progress).to.equal(75);
            expect(response.status).to.equal('executing');
            expect(queryBuilder.where.calledWith('JobId', 'abc-123')).to.be.true;
        });

        it('should throw when job does not exist', async () => {
            const queryBuilder = {
                where: sinon.stub().returnsThis(),
                firstOrFail: sinon.stub().rejects(new Error('Not found')),
            };
            sinon.stub(JobModel, 'select').returns(queryBuilder as any);

            await expect(controller.getStatus('unknown')).to.be.rejected;
        });
    });
});

