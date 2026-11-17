import { AuthzConfigError, AuthzDomains, DecisionAudit, DecisionReplay, ReplayBusy, thrownError } from '@spinajs/authz';
import type { Permission, Principal, ReplayReport } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, Get, NotFound, Ok, Policy, ServerError, TooManyRequests } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Config } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

import { AccessDomain } from '../access/domain-arg.js';
import { resolveAuthzDomain } from '../access/domain-resolver.js';
import { forbidden, holdsExplain, unauthenticated } from '../access/policy.js';
import { DecisionIdParam, DecisionsFormatQuery, RequestSignal } from '../dto/replay-report.js';
import { CurrentPrincipal } from '../principals/current-principal.js';
import { AuthzHttpRateLimit } from '../rate-limit/index.js';
import '../storage.js';

/** Allows a caller who holds `authz.http.decisionsRoute.permission` unconditionally in the access domain. */
export class DecisionsPolicy extends BasePolicy {
  @Config('authz.http.access.domain')
  protected AccessDomain: string;

  @Config('authz.http.decisionsRoute.permission')
  protected ReplayPermission: Permission;

  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    const principal = req.storage.Principal;
    if (!principal?.authenticated) throw unauthenticated('the decisions route needs an authenticated principal');

    const { held, decision } = await holdsExplain(await this.Domains.service(await resolveAuthzDomain(req, this.AccessDomain)), principal, this.ReplayPermission);
    if (!held) throw forbidden(decision);
  }
}

/** Retry-After of a replay refused because `authz.replay.concurrency` replays run already. */
const BUSY_RETRY_SECONDS = 5;

/**
 * `GET /authz/decisions/:id/explain?format=report|tree`: replays a logged decision through the registered
 * `DecisionReplay` (Bet 6 L3). Mounted by DecisionsControllerSource when `authz.http.decisionsRoute.enabled`, also in
 * production: it replays only decisions that happened. A report names the principal's facts, its captured inputs and
 * the other holders of the relations read, so the route has a permission of its own, held in the record's domain too.
 */
@BasePath('authz')
export class DecisionsController extends BaseController {
  @Logger('authz-http')
  protected Log: Log;

  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  @Autoinject(DecisionReplay)
  protected Replay: DecisionReplay;

  @Config('authz.http.decisionsRoute.permission')
  protected ReplayPermission: Permission;

  /**
   * Replays one logged decision at its instant. Every verdict, `unreplayable` included, is a 200; an id of a domain the
   * caller may not replay in answers as an unknown one.
   *
   * @returns {ReplayReportDto} The replay report, or its `tree` with `format=tree`
   */
  @Get('decisions/:id/explain')
  @AuthzHttpRateLimit('decisions')
  @Policy(DecisionsPolicy)
  public async explain(@AccessDomain() domain: string, @CurrentPrincipal() principal: Principal, @DecisionIdParam() id: string, @RequestSignal() signal: AbortSignal | undefined, @DecisionsFormatQuery() format?: string) {
    let report: ReplayReport | undefined;
    try {
      // Never inside a transaction: DbDecisionReplay refuses to replay in one.
      report = await this.Replay.replay(id, signal === undefined ? {} : { signal });
    } catch (e) {
      if (e instanceof ReplayBusy) return new TooManyRequests({ error: 'replay_busy', message: e.message }, { retryAfterSeconds: BUSY_RETRY_SECONDS });
      if (!(e instanceof AuthzConfigError)) throw e;
      // Answered, not thrown: a thrown 500 is redacted in production, and an operator must learn why the replay was refused.
      this.Log.error({ error: e, decisionId: id }, 'authz-http: the replay of decision ${decisionId} was refused');
      return new ServerError({ error: 'replay_refused', message: e.message });
    }
    if (report === undefined || !(await this.mayReplayIn(report.decision.domain, domain, principal))) return new NotFound({ error: 'not_found', message: `no decision ${id}` });

    await this.audit(domain, principal, report);
    return new Ok(format === 'tree' ? report.tree : report);
  }

  private async mayReplayIn(recordDomain: string, accessDomain: string, principal: Principal): Promise<boolean> {
    if (recordDomain === accessDomain) return true;
    if (!this.Domains.names().includes(recordDomain)) return false;
    // A failing check (the domain does not declare the permission) is not a grant, and a 500 would confirm the id.
    const held = await holdsExplain(await this.Domains.service(recordDomain), principal, this.ReplayPermission).catch(() => undefined);
    return held?.held === true;
  }

  private async audit(domain: string, principal: Principal, report: ReplayReport): Promise<void> {
    const { id, permission, resource } = report.decision;
    try {
      const audit = await this.Domains.container(domain).resolveOptional(DecisionAudit);
      await audit?.record({ kind: 'explain', principal: { type: principal.type, id: principal.id }, permission, resource, reason: `replay ${id}` });
    } catch (e) {
      this.Log.error({ error: thrownError(e), decisionId: id }, 'authz-http: the audit of the replay of decision ${decisionId} failed');
    }
  }
}
