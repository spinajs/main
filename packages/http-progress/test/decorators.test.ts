import 'mocha';
import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { HTTP_STATUS_CODE } from '@spinajs/http';
import { BackgroundJob, ProgressReporter } from '../src/decorators.js';
import { BackgroundFileResult } from '../src/models/JobEntry.js';
import { JobProgressService } from '../src/services/JobProgressService.js';

chai.use(chaiAsPromised);

// Helper: wait for setImmediate queue to drain
const waitImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('@BackgroundJob / @ProgressReporter', function () {
    this.timeout(5000);

    let mockService: sinon.SinonStubbedInstance<JobProgressService>;
    let mockResponse: { status: sinon.SinonStub };

    beforeEach(() => {
        mockService = sinon.createStubInstance(JobProgressService);
        mockService.create.returns('test-job-id');
        mockService.createDownloadToken.returns('test-download-token');

        // Pre-populate DI cache — works with ESM (no stub on exported function needed)
        DI.RootContainer.Cache.add(JobProgressService, mockService);

        mockResponse = { status: sinon.stub() };
    });

    afterEach(() => {
        DI.RootContainer.Cache.remove(JobProgressService);
        sinon.restore();
    });

    it('should immediately return { jobId } with HTTP 202', async () => {
        class FakeController {
            Response = mockResponse;

            @BackgroundJob()
            async myAction() {
                return { data: 'result' };
            }
        }

        const ctrl = new FakeController();
        const result = await ctrl.myAction();

        expect(result).to.deep.equal({ jobId: 'test-job-id' });
        expect(mockResponse.status.calledWith(HTTP_STATUS_CODE.ACCEPTED)).to.be.true;
    });

    it('should NOT call original method synchronously', async () => {
        const originalSpy = sinon.spy();

        class FakeController {
            Response = mockResponse;

            @BackgroundJob()
            async myAction() {
                originalSpy();
                return {};
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction();

        // Before setImmediate drains
        expect(originalSpy.called).to.be.false;

        await waitImmediate();

        // After setImmediate drains
        expect(originalSpy.calledOnce).to.be.true;
    });

    it('should call service.complete after original method resolves', async () => {
        class FakeController {
            Response = mockResponse;

            @BackgroundJob()
            async myAction() {
                return { some: 'data' };
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction();
        await waitImmediate();

        expect(mockService.complete.calledWith('test-job-id')).to.be.true;
    });

    it('should create download token when method returns BackgroundFileResult', async () => {
        class FakeController {
            Response = mockResponse;

            @BackgroundJob()
            async myAction() {
                return new BackgroundFileResult({
                    path: '/tmp/file.pdf',
                    provider: 'fs-temp',
                    filename: 'offer.pdf',
                });
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction();
        await waitImmediate();

        expect(
            mockService.createDownloadToken.calledWith('/tmp/file.pdf', 'fs-temp', 'offer.pdf'),
        ).to.be.true;
        expect(mockService.complete.calledWith('test-job-id', 'test-download-token')).to.be.true;
    });

    it('should call service.fail when original method throws', async () => {
        const boom = new Error('Rendering failed');

        class FakeController {
            Response = mockResponse;

            @BackgroundJob()
            async myAction() {
                throw boom;
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction();
        await waitImmediate();

        expect(mockService.fail.calledWith('test-job-id', boom)).to.be.true;
    });

    it('@ProgressReporter should inject reporter function into marked parameter', async () => {
        let capturedReporter: any;

        class FakeController {
            Response = mockResponse;

            @BackgroundJob()
            async myAction(@ProgressReporter() progress: any) {
                capturedReporter = progress;
                return {};
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction(undefined as any);
        await waitImmediate();

        expect(capturedReporter).to.be.a('function');
    });

    it('calling reporter(50) should call service.update with correct args', async () => {
        class FakeController {
            Response = mockResponse;

            @BackgroundJob()
            async myAction(@ProgressReporter() progress: any) {
                progress(50, 'halfway');
                return {};
            }
        }

        const ctrl = new FakeController();
        await ctrl.myAction(undefined as any);
        await waitImmediate();

        expect(mockService.update.calledWith('test-job-id', 50, 'halfway')).to.be.true;
    });
});
