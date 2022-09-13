import { BasePath, BaseController, Get, TemplateResponse } from '@spinajs/http';

@BasePath('responses')
export class TestResponses extends BaseController {
  @Get()
  public testPugIntl() {
    return new TemplateResponse('test-view-intl.pug', { sampleText: 'witaj świecie' });
  }
}
