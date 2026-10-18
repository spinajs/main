import { BasePath, BaseController, Get, TemplateResponse, ServerError, Ok, Created, Accepts, HttpAcceptHeaders } from '../../src/index.js';

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
  public fromPromise() {
    const action = async () => {
      return new Promise((res) => {
        res({ message: 'hello world' });
      });
    };

    return new Ok(action());
  }

  @Get()
  public created() {
    return new Created({ id: 1 });
  }

  @Get()
  @Accepts(HttpAcceptHeaders.JSON)
  public acceptsJson() {
    return new Ok({ message: 'hello world' });
  }
}
