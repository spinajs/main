import { AuthzDomains, AuthzService, SYSTEM } from "@spinajs/authz";
import { Access } from "@spinajs/authz-http";
import { DI } from "@spinajs/di";
import { ResourceNotFound } from "@spinajs/exceptions";
import { BaseController, BasePath, Get, Ok, Param, Req } from "@spinajs/http";
import type { Request } from "@spinajs/http";
import { JobModel } from "@spinajs/queue";
import { IJobStatusResponse } from "../models/JobEntry.js";

@BasePath("jobs/v1")
export class JobsController extends BaseController {
  @Get(":jobId/status")
  @Access("job:read")
  public async getStatus(@Param() jobId: string, @Req() req: Request): Promise<Ok> {
    const authz = await this.authzOf(req);
    const found = await authz.runAs(SYSTEM, "job-status:load", () => JobModel.select().where("JobId", jobId).first());
    // The job resource id is the integer Id, not the uuid JobId (RFC L6-2).
    const row = found && (await this.canRead(req, found)) ? found : undefined;

    // An unknown and a denied job answer alike, so the route does not reveal which jobs exist.
    if (!row) {
      throw new ResourceNotFound(`Job ${jobId} not found`);
    }

    const failed = row.Status === "dead" || row.Status === "error";
    const response: IJobStatusResponse = {
      jobId: row.JobId,
      result: row.Result ?? undefined,
      progress: row.Progress,
      status: row.Status,
      phase: row.Phase ?? undefined,
      message: row.Message ?? undefined,
      error:
        failed || row.Status === "retrying"
          ? row.LastError ?? undefined
          : undefined,
      attempt: row.Attempt,
      maxAttempts: row.MaxAttempts,
      createdAt: row.CreatedAt,
      finishedAt: row.FinishedAt,
    };

    return new Ok(response);
  }

  protected async authzOf(req: Request): Promise<AuthzService> {
    const domain = req.storage.AuthzHttpRoute?.domain ?? "root";
    return domain === "root"
      ? ((await DI.resolve(AuthzService)) as AuthzService)
      : await ((await DI.resolve(AuthzDomains)) as AuthzDomains).service(domain);
  }

  protected async canRead(req: Request, row: JobModel): Promise<boolean> {
    const principal = req.storage.Principal;
    if (!principal) return false;
    // The row is the subject: a ref alone leaves the grant's owner relation to a second load.
    return (await this.authzOf(req)).can(principal, "job:read", { type: "job", id: String(row.Id) }, row);
  }
}
