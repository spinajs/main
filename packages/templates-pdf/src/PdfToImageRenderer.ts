import { PDFOptions, ScreenshotOptions } from 'puppeteer';
import { NotSupported } from '@spinajs/exceptions';
import { IInstanceCheck, Injectable, PerInstanceCheck } from '@spinajs/di';
import { BasePdfTemplate, RenderContext } from './BasePdfTemplate.js';
import { extname } from 'path';

import '@spinajs/templates-pug';
import { TemplateRenderer } from '@spinajs/templates';

export interface PdfToImageOptions {
  /**
   * PDF generation options (used as intermediate step)
   */
  pdfOptions?: PDFOptions;

  /**
   * Screenshot/image generation options
   */
  screenshotOptions: ScreenshotOptions;
}

/**
 * PDF-to-Image renderer that generates images from PDF templates
 * First renders to PDF, then captures as image
 */
@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class PdfToImageRenderer extends BasePdfTemplate implements IInstanceCheck {
  public get Type() {
    return 'pdf-image';
  }

  public get Extension() {
    const type = this.imageOptions.screenshotOptions.type || 'png';
    return `.${type}`;
  }

  constructor(protected imageOptions: PdfToImageOptions) {
    super();
  }

  __checkInstance__(creationOptions: any): boolean {
    return JSON.stringify(this.imageOptions) === JSON.stringify(creationOptions);
  }

  /**
   * Perform image rendering from PDF
   */
  protected async performRender(context: RenderContext, filePath: string): Promise<void> {
    // Determine image type from file extension or options
    const fileExt = extname(filePath).toLowerCase().slice(1);
    const imageType = (fileExt === 'jpg' || fileExt === 'jpeg' || fileExt === 'png' || fileExt === 'webp')
      ? fileExt
      : this.imageOptions.screenshotOptions.type || 'png';

    // Take screenshot
    await context.page.screenshot({
      path: filePath,
      type: imageType as 'png' | 'jpeg' | 'webp',
      ...this.imageOptions.screenshotOptions,
    });

    this.Log.trace(`Generated image from PDF template: ${filePath}`);
  }

  public async render(_templateName: string, _model: unknown, _language?: string): Promise<string> {
    throw new NotSupported('cannot render pdf-image template to string');
  }
}
