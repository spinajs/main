import { AuthzAdminFailure, AuthzDomains } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import type { AuthzAdmin, AuthzAdminQuery, AuthzCommand, Principal } from '@spinajs/authz';
import { BaseController, BasePath, Body, Del, Get, Middleware, OnError, Param, Patch, Policy, Post, Put } from '@spinajs/http';
import type { Response } from '@spinajs/http';
import { CurrentPrincipal, IsAuthenticated, UnknownAuthzDomain } from '@spinajs/authz-http';
import { InvalidArgument } from '@spinajs/exceptions';
import { ValidationFailed } from '@spinajs/validation';

import '../schemas/provider.js';
import { AuthzAssignmentGrant, AuthzAssignmentPatch } from '../dto/assignments.js';
import { AuthzAttributesBody, AuthzAttributesPatch } from '../dto/attributes.js';
import type { AuthzAdminCommandBatch } from '../dto/batch.js';
import { AuthzLinkCreate, AuthzLinkPatch } from '../dto/links.js';
import { ID_PARAM, TYPE_PARAM } from '../dto/params.js';
import { AuthzAssignmentsQuery, AuthzHoldersQuery, AuthzListQuery, AuthzOffsetListQuery, AuthzWriteOptionsQuery } from '../dto/queries.js';
import { AuthzPolicyBody, AuthzRuleBody } from '../dto/rules.js';
import { adminInputAnswer, refused, respond } from '../routes/answers.js';
import { AdminBatch, AdminBody, AdminDomain, AdminQuery } from '../routes/args.js';
import { decodeCommand } from '../routes/decode.js';
import { NoStore } from '../routes/no-store.js';
import { readAssignmentsQuery, readHoldersQuery, readPageQuery, readWriteOptions } from '../routes/query.js';
import { resultsStatus } from '../routes/status.js';

const PATCH_KINDS = { tags: 'assignment.setTags', addTags: 'assignment.addTags', removeTags: 'assignment.removeTags' } as const;

/** A body the route runs under its path id; an id in the body must equal it. */
function withPathId<T extends { id?: string }>(body: T, id: string): T & { id: string } {
  if (body.id !== undefined && body.id !== id) throw new AuthzAdminFailure('invalid_request', `the body id ${JSON.stringify(body.id)} is not the path id ${JSON.stringify(id)}`, 'id');
  return { ...body, id };
}

// The routes serve the RBAC and ABAC commands, whose AuthzCommandMap entries this package does not import.
const byId = (kind: string, id: string): AuthzCommand => ({ kind, id }) as unknown as AuthzCommand;
const asCommand = (c: unknown): AuthzCommand => decodeCommand(c) as AuthzCommand;

/**
 * Admin routes over the management API of the configured domain (`authz.http.admin.domain`).
 *
 * The routes check authentication only: the actor is always the request principal, and every
 * permission and guard check runs in AuthzAdmin, as for an in-process caller (design §6.6.5). The
 * inputs are DTOs checked against their schemas first; a refused request answers
 * `{ error: { code, message, field? } }`, a write `{ results }`, one entry per command.
 *
 * @tags Authz admin
 */
@Policy(IsAuthenticated)
@BasePath({ config: 'authz.http.admin.basePath', default: 'authz' })
@OnError([ValidationFailed, InvalidArgument, AuthzAdminFailure, UnknownAuthzDomain], adminInputAnswer, { stages: ['arguments'] })
export class AuthzAdminController extends BaseController {
  @Config('authz.http.admin.domain')
  protected AdminDomain: string;

  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  /**
   * Runs a route on the AuthzAdmin of `domain` (the one `@AdminDomain()` resolved), `authz.http.admin.domain` without one.
   * An AuthzAdminFailure becomes its status with `{ error }`, anything else propagates.
   */
  protected async guarded(fn: (admin: AuthzAdmin) => Promise<Response>, domain?: string): Promise<Response> {
    const admin = (await this.Domains.service(domain ?? this.AdminDomain)).admin();
    try {
      return await fn(admin);
    } catch (e) {
      if (e instanceof AuthzAdminFailure) return refused(e);
      throw e;
    }
  }

  /** One batch built from the route, with the options of the query string. */
  protected single(domain: string, actor: Principal, options: AuthzWriteOptionsQuery, build: () => AuthzCommand[]) {
    return this.guarded(async (admin) => results(await admin.execute(actor, build(), readWriteOptions(options))), domain);
  }

  protected list(domain: string, actor: Principal, build: () => AuthzAdminQuery) {
    return this.guarded(async (admin) => respond(200, await admin.list(actor, build())), domain);
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
  @Middleware(NoStore)
  public async commands(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @AdminBatch() batch: AuthzAdminCommandBatch) {
    return this.guarded(async (admin) => results(await admin.execute(actor, batch.commands as AuthzCommand[], batch.options)), domain);
  }

  /**
   * List assignments
   * Lists assignments, filtered by the query.
   * Query: `scope` (`<type>` or `<type>:<id>`), `subject` (`<type>:<id>` or `set:<role>@<type>:<id>`), `role`, `includeExpired` (`true` or `false`), `limit`, `offset` or `after` (the `next` of the previous page).
   * @response 200 {AuthzAdminPage} One page of rows
   * @response 400 {AuthzAdminError} invalid_query: a malformed query parameter
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden: the caller lacks the read permission at the scope
   */
  @Get('assignments')
  public async listAssignments(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @AdminQuery() query: AuthzAssignmentsQuery) {
    return this.list(domain, actor, () => readAssignmentsQuery(query));
  }

  /**
   * List holders
   * Who holds a permission on a resource through role assignments on it, its ancestors or $global; each principal is verified by a fresh check.
   * Query: `scope` (`<type>:<id>`), `permission`, `expandSets` (`true` or `false`), `limit`, `offset` or `after` (the `next` of the previous page).
   * @response 200 {AuthzAdminPage} One page of holders
   * @response 400 {AuthzAdminError} invalid_query: a malformed or missing query parameter
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden: the caller lacks authz:holders.read at the resource, or the resource is unknown
   */
  @Get('holders')
  public async listHolders(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @AdminQuery() query: AuthzHoldersQuery) {
    return this.list(domain, actor, () => readHoldersQuery(query));
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
  public async grant(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Body({ required: true }) body: AuthzAssignmentGrant, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [asCommand({ ...body, kind: 'assignment.grant' })]);
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
  public async patchAssignment(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(ID_PARAM) id: string, @Body({ required: true }) body: AuthzAssignmentPatch, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => {
      const commands: AuthzCommand[] = [];
      for (const key of ['tags', 'addTags', 'removeTags'] as const) if (body[key] !== undefined) commands.push({ kind: PATCH_KINDS[key], id, tags: body[key] } as unknown as AuthzCommand);
      if (body.expiresAt !== undefined) commands.push(asCommand({ kind: 'assignment.setExpiry', id, expiresAt: body.expiresAt }));
      return commands;
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
  public async revoke(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(ID_PARAM) id: string, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [byId('assignment.revoke', id)]);
  }

  /**
   * List share links
   * Lists the share links, filtered by the query. A listing never carries a token or its hash: the token is shown once, when the link is created.
   * Query: `scope` (`<type>` or `<type>:<id>`), `limit`, `offset` or `after` (the `next` of the previous page).
   * @response 200 {AuthzAdminPage} One page of rows
   * @response 400 {AuthzAdminError} invalid_query: a malformed query parameter
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden: the caller lacks the read permission at the scope
   */
  @Get('links')
  public async listLinks(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @AdminQuery() query: AuthzListQuery) {
    return this.list(domain, actor, () => readPageQuery('links', query));
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
  @Middleware(NoStore)
  public async createLink(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Body({ required: true }) body: AuthzLinkCreate, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [asCommand({ ...body, kind: 'link.create' })]);
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
  public async patchLink(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(ID_PARAM) id: string, @Body({ required: true }) body: AuthzLinkPatch, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [asCommand({ ...withPathId(body, id), kind: 'link.update' })]);
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
  public async revokeLink(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(ID_PARAM) id: string, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [byId('link.revoke', id)]);
  }

  /**
   * List rules
   * Lists the RBAC rules held as rows.
   * Query: `scope` (`<type>` or `<type>:<id>`), `limit`, `offset` or `after` (the `next` of the previous page).
   * @response 200 {AuthzAdminPage} One page of rows
   * @response 400 {AuthzAdminError} invalid_query: a malformed query parameter
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {AuthzAdminError} forbidden: the caller lacks the read permission at the scope
   */
  @Get('rules')
  public async listRules(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @AdminQuery() query: AuthzListQuery) {
    return this.list(domain, actor, () => readPageQuery('rules', query));
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
  public async putRule(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(ID_PARAM) id: string, @Body({ required: true }) body: AuthzRuleBody, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [asCommand({ kind: 'rule.put', rule: withPathId(body, id) })]);
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
  public async deleteRule(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(ID_PARAM) id: string, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [byId('rule.delete', id)]);
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
  public async listPolicies(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @AdminQuery() query: AuthzOffsetListQuery) {
    return this.list(domain, actor, () => readPageQuery('policies', query));
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
  public async putPolicy(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(ID_PARAM) id: string, @Body({ required: true }) body: AuthzPolicyBody, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [asCommand({ kind: 'policy.put', policy: withPathId(body, id) })]);
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
  public async deletePolicy(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(ID_PARAM) id: string, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [byId('policy.delete', id)]);
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
  public async attributes(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(TYPE_PARAM) type: string, @Param(ID_PARAM) id: string) {
    return this.list(domain, actor, () => ({ kind: 'attributes', scope: { type, id } }));
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
  public async patchAttributes(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(TYPE_PARAM) type: string, @Param(ID_PARAM) id: string, @AdminBody() body: AuthzAttributesPatch, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [{ kind: 'scope.setAttributes', scope: { type, id }, patch: { ...body } }]);
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
  public async replaceAttributes(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(TYPE_PARAM) type: string, @Param(ID_PARAM) id: string, @AdminBody() body: AuthzAttributesBody, @AdminQuery() options: AuthzWriteOptionsQuery) {
    return this.single(domain, actor, options, () => [{ kind: 'scope.replaceAttributes', scope: { type, id }, attributes: { ...body } }]);
  }
}

function results(r: Awaited<ReturnType<AuthzAdmin['execute']>>): Response {
  return respond(resultsStatus(r), { results: r });
}
