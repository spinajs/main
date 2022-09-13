import { join } from 'lodash';
import { normalize, resolve } from 'path';
import { BasePath, BaseController, Get, TemplateResponse, ServerError, Ok, FileResponse } from '../../src';

@BasePath('responses')
export class TestResponses extends BaseController {
  @Get()
  public data() {
    return new Ok({ message: 'hello world' });
  }

  @Get()
  public testError() {
    return new ServerError({ message: 'sample error message' });
  }

  @Get()
  public testPug() {
    return new TemplateResponse('test-view.pug', { sampleText: 'hello world' });
  }

  @Get()
  public testPugIntl() {
    return new TemplateResponse('test-view-intl.pug', { sampleText: 'witaj świecie' });
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
