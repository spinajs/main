import { join } from 'lodash';
import { normalize, resolve } from 'path';
import { BasePath, BaseController, Get, PugResponse, ServerError, Ok, FileResponse } from '../../src';

@BasePath('sample-controller/v1/responses')
export class TestResponses extends BaseController {
  @Get()
  public testError() {
    return new ServerError({ error: true, message: 'sample error message' });
  }

  @Get()
  public testPug() {
    return new PugResponse('test-view.pug', { sampleText: 'hello world' });
  }

  @Get()
  public testPugIntl() {
    return new PugResponse('test-view-intl.pug', { sampleText: 'witaj świecie' });
  }

  @Get()
  public testJsonResponse() {
    return new Ok({ message: 'hello world' });
  }

  @Get()
  public testDataTransformer() {
    return new Ok({ message: 'hello world' });
  }

  @Get()
  public testFileResponse() {
    return new FileResponse(normalize(join(resolve(__dirname), './../public/index.html')), 'index.html');
  }
}
