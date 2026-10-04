import { AuthzDomains, AuthzService, authzStorage } from "@spinajs/authz";
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
    const row = await authzStorage().run(
      req.storage as unknown as Record<string, unknown>,
      async () => {
        const found = await JobModel.select().where("JobId", jobId).first();
        // The job resource id is the integer Id, not the uuid JobId (RFC L6-2).
        return found && (await this.canRead(req, found.Id)) ? found : undefined;
      },
    );

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

  protected async canRead(req: Request, id: number): Promise<boolean> {
    const principal = req.storage.Principal;
    if (!principal) return false;
    const domain = req.storage.AuthzHttpRoute?.domain ?? "root";
    const authz =
      domain === "root"
        ? ((await DI.resolve(AuthzService)) as AuthzService)
        : await ((await DI.resolve(AuthzDomains)) as AuthzDomains).service(domain);
    return authz.can(principal, "job:read", { type: "job", id: String(id) });
  }
}
