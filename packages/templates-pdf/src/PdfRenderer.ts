import { PDFOptions } from 'puppeteer';
import { NotSupported } from '@spinajs/exceptions';
import { IInstanceCheck, Injectable, PerInstanceCheck } from '@spinajs/di';
import { BasePdfTemplate, RenderContext } from './BasePdfTemplate.js';

import '@spinajs/templates-pug';
import { TemplateRenderer } from '@spinajs/templates';

/**
 * PDF renderer that generates PDF files from templates
 */
@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class PdfRenderer extends BasePdfTemplate implements IInstanceCheck {
  public get Type() {
    return 'pdf';
  }

  public get Extension() {
    return '.pdf';
  }

  constructor(protected pdfOptions: PDFOptions) {
    super();
  }

  __checkInstance__(creationOptions: any): boolean {
    return JSON.stringify(this.pdfOptions) === JSON.stringify(creationOptions);
  }

  /**
   * Perform PDF rendering
   */
  protected async performRender(context: RenderContext, filePath: string): Promise<void> {
    await context.page.pdf({
      path: filePath,
      ...this.pdfOptions,
    });
  }

  public async render(_templateName: string, _model: unknown, _language?: string): Promise<string> {
    throw new NotSupported('cannot render pdf template to string');
  }
}
