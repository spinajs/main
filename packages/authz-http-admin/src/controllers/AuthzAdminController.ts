import { AuthzAdminFailure } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import type { AuthzAdmin, AuthzAdminOptions, AuthzAdminQuery, AuthzCommand, Principal, ResourceRef } from '@spinajs/authz';
import { BadRequestResponse, BaseController, BasePath, Conflict, Del, ForbiddenResponse, Get, NotFound, Ok, Patch, Policy, Post, Put, Req } from '@spinajs/http';
import type { Request, Response } from '@spinajs/http';
import { IsAuthenticated } from '@spinajs/authz-http';

import '../schemas/provider.js';
import { decodeCommand, decodeCommands } from '../routes/decode.js';
import { domainAdmin } from '../routes/domain.js';
import { readAssignmentsQuery, readPageQuery, readWriteOptions } from '../routes/query.js';
import type { QueryInput } from '../routes/query.js';
import { adminErrorStatus, resultsStatus } from '../routes/status.js';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const PATCH_KEYS = ['tags', 'addTags', 'removeTags', 'expiresAt'] as const;
const PATCH_KINDS = { tags: 'assignment.setTags', addTags: 'assignment.addTags', removeTags: 'assignment.removeTags' } as const;

function respond(status: number, body: unknown): Response {
  switch (status) {
    case 200:
      return new Ok(body);
    case 403:
      return new ForbiddenResponse(body);
    case 404:
      return new NotFound(body);
    case 409:
      return new Conflict(body);
    default:
      return new BadRequestResponse(body);
  }
}

function refused(e: AuthzAdminFailure): Response {
  return respond(adminErrorStatus(e.code), { error: { code: e.code, message: e.message, ...(e.field === undefined ? {} : { field: e.field }) } });
}

function badRequest(message: string, field?: string): never {
  throw new AuthzAdminFailure('invalid_request', message, field);
}

function objectBody(body: unknown, what: string): Record<string, unknown> {
  if (!isRecord(body)) badRequest(`the body must be ${what}`);
  return body;
}

/** The body of PUT /authz/rules/:id or /authz/policies/:id with the path id; an id in the body must equal it. */
function withPathId(body: unknown, id: string, what: string): Record<string, unknown> {
  const o = objectBody(body, what);
  if (o.id !== undefined && o.id !== id) badRequest(`the body id ${JSON.stringify(o.id)} is not the path id ${JSON.stringify(id)}`, 'id');
  return { ...o, id };
}

const LINK_PATCH_KEYS = ['expiresAt', 'attributes', 'role', 'tags'] as const;

/** PATCH /authz/links/:id as one link.update; like the assignment patch, a key it does not serve is refused, not ignored. */
function linkUpdate(body: unknown, id: string): AuthzCommand {
  const patch = withPathId(body, id, 'an object { expiresAt?, attributes?, role?, tags? }');
  const unknown = Object.keys(patch).find((k) => k !== 'id' && !(LINK_PATCH_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined) badRequest(`a link patch takes ${LINK_PATCH_KEYS.join(', ')}, not ${JSON.stringify(unknown)}`, unknown);
  if (!LINK_PATCH_KEYS.some((k) => k in patch)) badRequest(`a link patch needs one of ${LINK_PATCH_KEYS.join(', ')}`);
  return decodeCommand({ ...patch, kind: 'link.update' }) as AuthzCommand;
}

/** For answers that may hold a link token: no proxy or browser cache may keep one. Set first, so it goes out with any answer the route gives. */
function noStore(req: Request): void {
  req.res?.setHeader('Cache-Control', 'no-store');
  req.res?.setHeader('Pragma', 'no-cache');
}

const query = (req: Request): QueryInput => (req.query ?? {}) as QueryInput;
const param = (req: Request, name: string): string => req.params[name] as string;
const actorOf = (req: Request): Principal => req.storage.Principal!;
const scopeOf = (req: Request): ResourceRef => ({ type: param(req, 'type'), id: param(req, 'id') });

/**
 * Admin routes over the management API of the configured domain (`authz.http.admin.domain`).
 *
 * The routes check authentication only: the actor is always the request principal, and every
 * permission, validation and guard check runs in AuthzAdmin, as for an in-process caller (design
 * §6.6.5). A refused request answers `{ error: { code, message, field? } }`; a write answers
 * `{ results }`, one entry per command.
 *
 * @tags Authz admin
 */
@Policy(IsAuthenticated)
@BasePath('authz')
export class AuthzAdminController extends BaseController {
  @Config('authz.http.admin.domain')
  protected AdminDomain: string;

  /** Runs a route on the domain's AuthzAdmin; an AuthzAdminFailure becomes its status with `{ error }`, anything else propagates. */
  protected async guarded(fn: (admin: AuthzAdmin) => Promise<Response>): Promise<Response> {
    const admin = await domainAdmin(this.AdminDomain);
    try {
      return await fn(admin);
    } catch (e) {
      if (e instanceof AuthzAdminFailure) return refused(e);
      throw e;
    }
  }

  /** One batch built from the route, with the options of the query string. */
  protected single(req: Request, build: () => AuthzCommand[]) {
    return this.guarded(async (admin) => {
      const opts = readWriteOptions(query(req));
      return results(await admin.execute(actorOf(req), build(), opts));
    });
  }

  protected list(req: Request, build: () => AuthzAdminQuery) {
    return this.guarded(async (admin) => respond(200, await admin.list(actorOf(req), build())));
  }

  /**
   * Run a batch of commands
   * Runs the commands in order in one transaction on the configured domain; the first failure rolls the batch back and its status is the answer.
   * Body: { commands, reason?, idempotencyKey?, dryRun? } (schema AuthzAdminBatch); `commands` lists the command kinds of AuthzCommand, with dates as ISO 8601 strings. The options go in the body, not the query string.
   * The result of a link.create carries the link token, shown once: every answer the route sends carries `Cache-Control: no-store` (the 401 of the authentication check comes before the route and holds no token), and a retried or dry-run batch answers without the token.
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Post('commands')
  public async commands(@Req() req: Request) {
    noStore(req);
    return this.guarded(async (admin) => {
      const body = objectBody(req.body, 'an object { commands, reason?, idempotencyKey?, dryRun? }');
      const opts: Record<string, unknown> = {};
      for (const key of ['reason', 'idempotencyKey', 'dryRun'] as const) if (key in body) opts[key] = body[key];
      return results(await admin.execute(actorOf(req), decodeCommands(body.commands) as AuthzCommand[], opts as AuthzAdminOptions));
    });
  }

  /**
   * List assignments
   * Lists assignments, filtered by the query.
   * Query: `scope` (`<type>` or `<type>:<id>`), `subject` (`<type>:<id>` or `set:<role>@<type>:<id>`), `role`, `includeExpired` (`true` or `false`), `limit`, `offset`.
   * @response 200 {AuthzAdminPage} One page of rows
   * @response 400 {AuthzAdminError} invalid_query: a malformed query parameter
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden: the caller lacks the read permission at the scope
   */
  @Get('assignments')
  public async listAssignments(@Req() req: Request) {
    return this.list(req, () => readAssignmentsQuery(query(req)));
  }

  /**
   * Grant a role
   * Grants a role to a subject at a scope (assignment.grant).
   * Body: the fields of assignment.grant without `kind` (schema AuthzAssignmentGrant).
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Post('assignments')
  public async grant(@Req() req: Request) {
    return this.single(req, () => [decodeCommand({ ...objectBody(req.body, 'the fields of assignment.grant'), kind: 'assignment.grant' }) as AuthzCommand]);
  }

  /**
   * Change an assignment
   * Changes the tags or the expiry of an assignment.
   * Body: { tags?, addTags?, removeTags?, expiresAt? } with at least one key (schema AuthzAssignmentPatch); the keys run as one batch.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Patch('assignments/:id')
  public async patchAssignment(@Req() req: Request) {
    return this.single(req, () => {
      const body = objectBody(req.body, 'an object { tags?, addTags?, removeTags?, expiresAt? }');
      const unknown = Object.keys(body).find((k) => !(PATCH_KEYS as readonly string[]).includes(k));
      if (unknown !== undefined) badRequest(`an assignment patch takes ${PATCH_KEYS.join(', ')}, not ${JSON.stringify(unknown)}`, unknown);
      const id = param(req, 'id');
      const commands: unknown[] = [];
      for (const key of ['tags', 'addTags', 'removeTags'] as const) if (key in body) commands.push({ kind: PATCH_KINDS[key], id, tags: body[key] });
      if ('expiresAt' in body) commands.push(decodeCommand({ kind: 'assignment.setExpiry', id, expiresAt: body.expiresAt }));
      if (commands.length === 0) badRequest(`an assignment patch needs one of ${PATCH_KEYS.join(', ')}`);
      return commands as AuthzCommand[];
    });
  }

  /**
   * Revoke an assignment
   * Revokes the assignment with the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Del('assignments/:id')
  public async revoke(@Req() req: Request) {
    return this.single(req, () => [{ kind: 'assignment.revoke', id: param(req, 'id') }]);
  }

  /**
   * List share links
   * Lists the share links, filtered by the query. A listing never carries a token or its hash: the token is shown once, when the link is created.
   * Query: `scope` (`<type>` or `<type>:<id>`), `limit`, `offset`.
   * @response 200 {AuthzAdminPage} One page of rows
   * @response 400 {AuthzAdminError} invalid_query: a malformed query parameter
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden: the caller lacks the read permission at the scope
   */
  @Get('links')
  public async listLinks(@Req() req: Request) {
    return this.list(req, () => readPageQuery('links', query(req)));
  }

  /**
   * Create a share link
   * Creates a share link that grants a role at a scope (link.create). The result carries the link id and its token: the token is shown once, here, and every answer the route sends carries `Cache-Control: no-store` (the 401 of the authentication check comes before the route and holds no token). A dry run or a retried request (same idempotency key) answers without the token.
   * Body: the fields of link.create without `kind` (schema AuthzLinkCreate).
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} The link was created; results[0] holds its id and token
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Post('links')
  public async createLink(@Req() req: Request) {
    noStore(req);
    return this.single(req, () => [decodeCommand({ ...objectBody(req.body, 'the fields of link.create'), kind: 'link.create' }) as AuthzCommand]);
  }

  /**
   * Change a share link
   * Changes the expiry, attributes, role or tags of the link with the path id (link.update). The answer never carries the token.
   * Body: { expiresAt?, attributes?, role?, tags? } with at least one key (schema AuthzLinkPatch); an `id` in the body must equal the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Patch('links/:id')
  public async patchLink(@Req() req: Request) {
    return this.single(req, () => [linkUpdate(req.body, param(req, 'id'))]);
  }

  /**
   * Revoke a share link
   * Revokes the link with the path id and the role it grants (link.revoke); its token opens nothing from then on.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Del('links/:id')
  public async revokeLink(@Req() req: Request) {
    return this.single(req, () => [{ kind: 'link.revoke', id: param(req, 'id') }]);
  }

  /**
   * List rules
   * Lists the RBAC rules held as rows.
   * Query: `scope` (`<type>` or `<type>:<id>`), `limit`, `offset`.
   * @response 200 {AuthzAdminPage} One page of rows
   * @response 400 {AuthzAdminError} invalid_query: a malformed query parameter
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden: the caller lacks the read permission at the scope
   */
  @Get('rules')
  public async listRules(@Req() req: Request) {
    return this.list(req, () => readPageQuery('rules', query(req)));
  }

  /**
   * Put a rule
   * Inserts or replaces the RBAC rule with the path id.
   * Body: a rule (schema AuthzRuleBody); an `id` in the body must equal the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Put('rules/:id')
  public async putRule(@Req() req: Request) {
    return this.single(req, () => [decodeCommand({ kind: 'rule.put', rule: withPathId(req.body, param(req, 'id'), 'a rule') }) as AuthzCommand]);
  }

  /**
   * Delete a rule
   * Deletes the RBAC rule with the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Del('rules/:id')
  public async deleteRule(@Req() req: Request) {
    return this.single(req, () => [{ kind: 'rule.delete', id: param(req, 'id') }]);
  }

  /**
   * List policies
   * Lists the ABAC policies held as rows.
   * Query: `scope` (`<type>` or `<type>:<id>`), `limit`, `offset`.
   * @response 200 {AuthzAdminPage} One page of rows
   * @response 400 {AuthzAdminError} invalid_query: a malformed query parameter
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden: the caller lacks the read permission at the scope
   */
  @Get('policies')
  public async listPolicies(@Req() req: Request) {
    return this.list(req, () => readPageQuery('policies', query(req)));
  }

  /**
   * Put a policy
   * Inserts or replaces the ABAC policy with the path id.
   * Body: a policy (schema AuthzPolicyBody); an `id` in the body must equal the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Put('policies/:id')
  public async putPolicy(@Req() req: Request) {
    return this.single(req, () => [decodeCommand({ kind: 'policy.put', policy: withPathId(req.body, param(req, 'id'), 'a policy') }) as AuthzCommand]);
  }

  /**
   * Delete a policy
   * Deletes the ABAC policy with the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Del('policies/:id')
  public async deletePolicy(@Req() req: Request) {
    return this.single(req, () => [{ kind: 'policy.delete', id: param(req, 'id') }]);
  }

  /**
   * Read scope attributes
   * Returns the attributes of the scope node `<type>:<id>`.
   * @response 200 {AuthzAdminPage} items holds one entry, the attributes object of the scope; total is 1
   * @response 400 {AuthzAdminError} invalid_query: a malformed query parameter
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden: the caller lacks the read permission at the scope
   */
  @Get('scopes/:type/:id/attributes')
  public async attributes(@Req() req: Request) {
    return this.list(req, () => ({ kind: 'attributes', scope: scopeOf(req) }));
  }

  /**
   * Merge scope attributes
   * Deep-merges the body into the attributes of the scope node; null deletes a path.
   * Body: an object (schema AuthzAttributesPatch).
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Patch('scopes/:type/:id/attributes')
  public async patchAttributes(@Req() req: Request) {
    return this.single(req, () => [{ kind: 'scope.setAttributes', scope: scopeOf(req), patch: req.body }]);
  }

  /**
   * Replace scope attributes
   * Replaces all attributes of the scope node with the body.
   * Body: an object (schema AuthzAttributesBody).
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query (an option of the query string), invalid_batch or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Put('scopes/:type/:id/attributes')
  public async replaceAttributes(@Req() req: Request) {
    return this.single(req, () => [{ kind: 'scope.replaceAttributes', scope: scopeOf(req), attributes: req.body }]);
  }
}

function results(r: Awaited<ReturnType<AuthzAdmin['execute']>>): Response {
  return respond(resultsStatus(r), { results: r });
}
