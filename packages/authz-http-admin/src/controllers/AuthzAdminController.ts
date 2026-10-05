import { AuthzAdminFailure } from '@spinajs/authz';
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
@BasePath('authz')
export class AuthzAdminController extends BaseController {
  /**
   * Run a batch of commands
   * Runs the commands in order in one transaction on the configured domain; the first failure rolls the batch back and its status is the answer.
   * Body: { commands, reason?, idempotencyKey?, dryRun? } (schema AuthzAdminBatch); `commands` lists the command kinds of AuthzCommand, with dates as ISO 8601 strings. The options go in the body, not the query string.
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Post('commands')
  @Policy(IsAuthenticated)
  public async commands(@Req() req: Request) {
    return guarded(async (admin) => {
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
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   */
  @Get('assignments')
  @Policy(IsAuthenticated)
  public async listAssignments(@Req() req: Request) {
    return list(req, () => readAssignmentsQuery(query(req)));
  }

  /**
   * Grant a role
   * Grants a role to a subject at a scope (assignment.grant).
   * Body: the fields of assignment.grant without `kind` (schema AuthzAssignmentGrant).
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Post('assignments')
  @Policy(IsAuthenticated)
  public async grant(@Req() req: Request) {
    return single(req, () => [decodeCommand({ ...objectBody(req.body, 'the fields of assignment.grant'), kind: 'assignment.grant' }) as AuthzCommand]);
  }

  /**
   * Change an assignment
   * Changes the tags or the expiry of an assignment.
   * Body: { tags?, addTags?, removeTags?, expiresAt? } with at least one key (schema AuthzAssignmentPatch); the keys run as one batch.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Patch('assignments/:id')
  @Policy(IsAuthenticated)
  public async patchAssignment(@Req() req: Request) {
    return single(req, () => {
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
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Del('assignments/:id')
  @Policy(IsAuthenticated)
  public async revoke(@Req() req: Request) {
    return single(req, () => [{ kind: 'assignment.revoke', id: param(req, 'id') }]);
  }

  /**
   * List rules
   * Lists the RBAC rules held as rows.
   * Query: `scope` (`<type>` or `<type>:<id>`), `limit`, `offset`.
   * @response 200 {AuthzAdminPage} One page of rows
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   */
  @Get('rules')
  @Policy(IsAuthenticated)
  public async listRules(@Req() req: Request) {
    return list(req, () => readPageQuery('rules', query(req)));
  }

  /**
   * Put a rule
   * Inserts or replaces the RBAC rule with the path id.
   * Body: a rule (schema AuthzRuleBody); an `id` in the body must equal the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Put('rules/:id')
  @Policy(IsAuthenticated)
  public async putRule(@Req() req: Request) {
    return single(req, () => [decodeCommand({ kind: 'rule.put', rule: withPathId(req.body, param(req, 'id'), 'a rule') }) as AuthzCommand]);
  }

  /**
   * Delete a rule
   * Deletes the RBAC rule with the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Del('rules/:id')
  @Policy(IsAuthenticated)
  public async deleteRule(@Req() req: Request) {
    return single(req, () => [{ kind: 'rule.delete', id: param(req, 'id') }]);
  }

  /**
   * List policies
   * Lists the ABAC policies held as rows.
   * Query: `scope` (`<type>` or `<type>:<id>`), `limit`, `offset`.
   * @response 200 {AuthzAdminPage} One page of rows
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   */
  @Get('policies')
  @Policy(IsAuthenticated)
  public async listPolicies(@Req() req: Request) {
    return list(req, () => readPageQuery('policies', query(req)));
  }

  /**
   * Put a policy
   * Inserts or replaces the ABAC policy with the path id.
   * Body: a policy (schema AuthzPolicyBody); an `id` in the body must equal the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Put('policies/:id')
  @Policy(IsAuthenticated)
  public async putPolicy(@Req() req: Request) {
    return single(req, () => [decodeCommand({ kind: 'policy.put', policy: withPathId(req.body, param(req, 'id'), 'a policy') }) as AuthzCommand]);
  }

  /**
   * Delete a policy
   * Deletes the ABAC policy with the path id.
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Del('policies/:id')
  @Policy(IsAuthenticated)
  public async deletePolicy(@Req() req: Request) {
    return single(req, () => [{ kind: 'policy.delete', id: param(req, 'id') }]);
  }

  /**
   * Read scope attributes
   * Returns the attributes of the scope node `<type>:<id>`.
   * @response 200 {AuthzAdminAttributes} The attributes object
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: the scope node is unknown
   */
  @Get('scopes/:type/:id/attributes')
  @Policy(IsAuthenticated)
  public async attributes(@Req() req: Request) {
    return list(req, () => ({ kind: 'attributes', scope: scopeOf(req) }));
  }

  /**
   * Merge scope attributes
   * Deep-merges the body into the attributes of the scope node; null deletes a path.
   * Body: an object (schema AuthzAttributesPatch).
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Patch('scopes/:type/:id/attributes')
  @Policy(IsAuthenticated)
  public async patchAttributes(@Req() req: Request) {
    return single(req, () => [{ kind: 'scope.setAttributes', scope: scopeOf(req), patch: req.body }]);
  }

  /**
   * Replace scope attributes
   * Replaces all attributes of the scope node with the body.
   * Body: an object (schema AuthzAttributesBody).
   * Query: `reason` (audit text), `idempotencyKey`, `dryRun` (`true` validates and guards, then rolls back).
   * @response 200 {AuthzAdminResults} Every command succeeded
   * @response 400 {AuthzAdminError} invalid_request, invalid_query or a validation code of the command
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden, escalation, last_holder, self_lockout or protected_role
   * @response 404 {AuthzAdminError} not_found: a row the command names does not exist
   * @response 409 {AuthzAdminError} conflict: the row changed or exists already
   */
  @Put('scopes/:type/:id/attributes')
  @Policy(IsAuthenticated)
  public async replaceAttributes(@Req() req: Request) {
    return single(req, () => [{ kind: 'scope.replaceAttributes', scope: scopeOf(req), attributes: req.body }]);
  }
}

/** Runs a route on the domain's AuthzAdmin; an AuthzAdminFailure becomes its status with `{ error }`, anything else propagates. */
async function guarded(fn: (admin: AuthzAdmin) => Promise<Response>): Promise<Response> {
  const admin = await domainAdmin();
  try {
    return await fn(admin);
  } catch (e) {
    if (e instanceof AuthzAdminFailure) return refused(e);
    throw e;
  }
}

function results(r: Awaited<ReturnType<AuthzAdmin['execute']>>): Response {
  return respond(resultsStatus(r), { results: r });
}

/** One batch built from the route, with the options of the query string. */
function single(req: Request, build: () => AuthzCommand[]) {
  return guarded(async (admin) => {
    const opts = readWriteOptions(query(req));
    return results(await admin.execute(actorOf(req), build(), opts));
  });
}

function list(req: Request, build: () => AuthzAdminQuery) {
  return guarded(async (admin) => respond(200, await admin.list(actorOf(req), build())));
}
