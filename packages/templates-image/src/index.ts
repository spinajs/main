import { Page, ScreenshotOptions } from 'puppeteer';
import { PuppeteerRenderer, IPuppeteerRendererOptions } from '@spinajs/templates-puppeteer';
import { TemplateRenderer } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { Injectable, PerInstanceCheck } from '@spinajs/di';

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class ImageRenderer extends PuppeteerRenderer {
  /**
   * General options from configuration
   */
  @Config('templates.image')
  protected Options: IPuppeteerRendererOptions;

  public get Type() {
    return 'image';
  }

  public get Extension() {
    return `.${this.screenshotOptions?.type ?? 'png'}`;
  }

  constructor(protected screenshotOptions: ScreenshotOptions) {
    super();
  }

  protected get instanceOptions() {
    return this.screenshotOptions;
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.screenshot({
      path: filePath,
      ...this.screenshotOptions,
    });
  }
}
