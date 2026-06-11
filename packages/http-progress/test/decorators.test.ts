import 'mocha';
import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { TrackProgress, ProgressReporter } from '../src/decorators.js';
import { JobProgressService } from '../src/services/JobProgressService.js';

chai.use(chaiAsPromised);

describe('@TrackProgress / @ProgressReporter', function () {
    this.timeout(5000);

    let mockService: sinon.SinonStubbedInstance<JobProgressService>;

    beforeEach(() => {
        mockService = sinon.createStubInstance(JobProgressService);

        DI.RootContainer.Cache.add(JobProgressService, mockService);
    });

    afterEach(() => {
        DI.RootContainer.Cache.remove(JobProgressService);
        sinon.restore();
    });

    it('should return original method result when jobId is provided', async () => {
        class FakeController {
            Request = { query: { jobId: 'test-job-id' }, body: {} };

            @TrackProgress()
            async myAction() {
                return { data: 'result' };
            }
        }

        const ctrl = new FakeController();
        const result = await ctrl.myAction();

        expect(result).to.deep.equal({ data: 'result' });
    });

    it('should call service.create(jobId) when jobId is in query', async () => {
        class FakeController {
            Request = { query: { jobId: 'test-job-id' }, body: {} };

            @TrackProgress()
            async myAction() {
                return {};
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction();

        expect(mockService.create.calledWith('test-job-id')).to.be.true;
    });

    it('should call service.create(jobId) when jobId is in body', async () => {
        class FakeController {
            Request = { query: {}, body: { jobId: 'body-job-id' } };

            @TrackProgress()
            async myAction() {
                return {};
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction();

        expect(mockService.create.calledWith('body-job-id')).to.be.true;
    });

    it('should NOT call service.create when no jobId', async () => {
        class FakeController {
            Request = { query: {}, body: {} };

            @TrackProgress()
            async myAction() {
                return { data: 'result' };
            }
        }

        const ctrl = new FakeController();
        const result = await ctrl.myAction();

        expect(mockService.create.called).to.be.false;
        expect(result).to.deep.equal({ data: 'result' });
    });

    it('should call service.complete(jobId) after method resolves', async () => {
        class FakeController {
            Request = { query: { jobId: 'test-job-id' }, body: {} };

            @TrackProgress()
            async myAction() {
                return {};
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction();

        expect(mockService.complete.calledWith('test-job-id')).to.be.true;
    });

    it('should call service.fail and re-throw when method throws', async () => {
        const boom = new Error('Rendering failed');

        class FakeController {
            Request = { query: { jobId: 'test-job-id' }, body: {} };

            @TrackProgress()
            async myAction() {
                throw boom;
            }
        }

        const ctrl = new FakeController();
        await expect(ctrl.myAction()).to.be.rejectedWith('Rendering failed');

        expect(mockService.fail.calledWith('test-job-id', boom)).to.be.true;
    });

    it('should NOT call service.fail when no jobId and method throws', async () => {
        class FakeController {
            Request = { query: {}, body: {} };

            @TrackProgress()
            async myAction() {
                throw new Error('oops');
            }
        }

        const ctrl = new FakeController();
        await expect(ctrl.myAction()).to.be.rejectedWith('oops');

        expect(mockService.fail.called).to.be.false;
    });

    it('@ProgressReporter should inject reporter function when jobId present', async () => {
        let capturedReporter: any;

        class FakeController {
            Request = { query: { jobId: 'test-job-id' }, body: {} };

            @TrackProgress()
            async myAction(@ProgressReporter() progress: any) {
                capturedReporter = progress;
                return {};
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction(undefined as any);

        expect(capturedReporter).to.be.a('function');
    });

    it('@ProgressReporter should inject noop function when no jobId', async () => {
        let capturedReporter: any;

        class FakeController {
            Request = { query: {}, body: {} };

            @TrackProgress()
            async myAction(@ProgressReporter() progress: any) {
                capturedReporter = progress;
                return {};
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction(undefined as any);

        expect(capturedReporter).to.be.a('function');
        expect(() => capturedReporter(50, 'msg')).to.not.throw();
        expect(mockService.update.called).to.be.false;
    });

    it('calling reporter(50) should call service.update with correct args', async () => {
        class FakeController {
            Request = { query: { jobId: 'test-job-id' }, body: {} };

            @TrackProgress()
            async myAction(@ProgressReporter() progress: any) {
                progress(50, 'halfway');
                return {};
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction(undefined as any);

        expect(mockService.update.calledWith('test-job-id', 50, 'halfway')).to.be.true;
    });
});

