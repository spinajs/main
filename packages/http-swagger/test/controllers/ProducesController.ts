import { BaseController, BasePath, Del, FileResponse, Get, Ok, Param, Post } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

@Schema({
  type: 'object',
  required: ['number'],
  properties: { number: { type: 'string' }, total: { type: 'number' } },
})
export class ProducesInvoiceDto {
  number?: string;
  total?: number;
}

/**
 * Routes that answer with something other than JSON and say so with `@produces`.
 * @tags Produces
 */
@BasePath('produces')
export class ProducesController extends BaseController {
  /**
   * Metrics in the Prometheus text format
   * @produces text/plain; version=0.0.4
   * @returns Metric families of this process
   */
  @Get('metrics')
  public async metrics() {
    return new Ok('# HELP up 1');
  }

  /**
   * Invoices of a month
   * @produces application/json
   * @produces text/csv
   * @returns {ProducesInvoiceDto[]} Invoices, newest first
   * @response 404 No such month
   */
  @Get('invoices/:month')
  public async list(@Param() month: string) {
    return new Ok({ month });
  }

  /**
   * One invoice as XML
   * @produces application/xml
   * @returns {ProducesInvoiceDto} The invoice
   */
  @Get('xml')
  public async xml() {
    return new Ok({});
  }

  /**
   * Invoice as a PDF
   * @produces application/pdf
   */
  @Get('pdf')
  public async pdf(): Promise<FileResponse> {
    return new FileResponse({ path: 'invoice.pdf', filename: 'invoice.pdf', mimeType: 'application/pdf' });
  }

  /**
   * A chart
   * @produces image/png
   * @returns The chart
   */
  @Get('chart')
  public async chart() {
    return new Ok({});
  }

  /**
   * Import invoices from CSV
   * @produces text/csv
   * @response 201 {ProducesInvoiceDto} The rows that were imported
   * @response 409 {ProducesInvoiceDto} The invoice that already exists
   */
  @Post('import')
  public async import() {
    return new Ok({});
  }

  /**
   * Rows of a month
   * @produces text/csv
   * @response 200 Rows of the month
   */
  @Get('rows')
  public async rows() {
    return new Ok('a,b');
  }

  /**
   * Start an export
   * @produces application/pdf
   * @response 201 The export
   */
  @Post('export')
  public async export() {
    return new Ok({});
  }

  /**
   * Clear the rows
   * @produces text/csv
   * @response 204 Deleted
   */
  @Del('rows')
  public async clear() {
    return new Ok({});
  }
}
