import { Page, ScreenshotOptions } from 'puppeteer';
import { PuppeteerRenderer, IPuppeteerRendererOptions } from '@spinajs/templates-puppeteer';
import { TemplateRenderer } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { IInstanceCheck, Injectable, PerInstanceCheck } from '@spinajs/di';

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class ImageRenderer extends PuppeteerRenderer implements IInstanceCheck {
  /**
   * General options from configuration
   */
  @Config('templates.image')
  protected Options: IPuppeteerRendererOptions;

  public get Type() {
    return 'image';
  }

  public get Extension() {
    return '.png';
  }

  constructor(protected screenshotOptions: ScreenshotOptions) {
    super();
  }

  __checkInstance__(creationOptions: any): boolean {
    return JSON.stringify(this.screenshotOptions) === JSON.stringify(creationOptions);
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.screenshot({
      path: filePath,
      ...this.screenshotOptions,
    });
  }
}
