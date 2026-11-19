import { BaseController, BasePath, Get, Ok, Query } from '@spinajs/http';
import { Access } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { InvoiceService, ReportService } from './services.js';

@BasePath('invoices')
export class InvoicesController extends BaseController {
  @Autoinject(InvoiceService)
  protected Invoices: InvoiceService;

  @Autoinject(ReportService)
  protected Reports: ReportService;

  @Get('overdue')
  @Access('invoice:read')
  public async overdue(@Query() days: number) {
    return new Ok(await this.Invoices.overdue(days));
  }

  @Get('listed')
  @Access('invoice:read')
  public async listed() {
    return new Ok(await this.Invoices.listed());
  }

  @Get('stored')
  @Access('invoice:read')
  public async stored() {
    return new Ok(await this.Invoices.stored());
  }

  @Get('archive')
  @Access('invoice:update')
  public async archive() {
    await this.Invoices.archive();
    return new Ok();
  }

  @Get('purge')
  @Access('invoice:delete')
  public async purge(@Query() reason: string) {
    return new Ok(await this.Invoices.purge(reason));
  }

  @Get('nightly')
  @Access('invoice:read')
  public async nightly() {
    return new Ok(await this.Invoices.nightly());
  }

  @Get('reports')
  @Access('invoice:read')
  public async reports() {
    return new Ok(await this.Reports.rows());
  }

  @Get('both')
  @Access('invoice:read')
  public async both() {
    return new Ok(await this.Invoices.both());
  }

  @Get('ran')
  @Access('invoice:read')
  public async ran() {
    return new Ok(await this.Invoices.ran());
  }
}
