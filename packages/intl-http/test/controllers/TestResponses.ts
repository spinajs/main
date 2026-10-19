import { BasePath, BaseController, Get, TemplateResponse, Ok } from '@spinajs/http';
import { Lang } from '../../src/index.js';

@BasePath('responses')
export class TestResponses extends BaseController {
  @Get()
  public testPugIntl() {
    return new TemplateResponse('test-view-intl.pug', { sampleText: 'witaj świecie' });
  }

  @Get()
  public testLangFromParam(@Lang() lang: string) {
    return new Ok({ lang });
  }

  @Get()
  public testLangAllowedLanguages(@Lang(['en', 'pl']) lang: string) {
    return new Ok({ lang });
  }

  @Get()
  public testLangDefaultNotAllowed(@Lang(['en', 'de']) lang: string) {
    return new Ok({ lang });
  }
}
