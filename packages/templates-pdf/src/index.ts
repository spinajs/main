import { Page, PDFOptions } from 'puppeteer';
import { PuppeteerRenderer, IPuppeteerRendererOptions } from '@spinajs/templates-puppeteer';
import { TemplateRenderer } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { Injectable, PerInstanceCheck } from '@spinajs/di';

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class PdfRenderer extends PuppeteerRenderer {
  /**
   * General options from configuration
   */
  @Config('templates.pdf')
  protected Options: IPuppeteerRendererOptions;

  public get Type() {
    return 'pdf';
  }

  public get Extension() {
    return '.pdf';
  }

  constructor(protected pdfOptions: PDFOptions) {
    super();
  }

  protected get instanceOptions() {
    return this.pdfOptions;
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.pdf({
      path: filePath,
      ...this.pdfOptions,
    });
  }
}
