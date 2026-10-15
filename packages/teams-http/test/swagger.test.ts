import 'mocha';
import { resolve } from 'node:path';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Controllers } from '@spinajs/http';
import { OpenApiBuilder, SwaggerDocCache } from '@spinajs/http-swagger';
import type { IOpenApiDocument } from '@spinajs/http-swagger';

import { TEAMS_HTTP_CONTROLLERS, TEAMS_HTTP_ROUTES } from '../src/controller-list.js';
import { TEAMS_HTTP_SCHEMAS } from '../src/schemas/index.js';

// The controllers' JSDoc is read from the compiled files (`pretest` compiles them).
const compiled = (name: string) => resolve(process.cwd(), 'lib', 'mjs', 'controllers', `${name}.js`);
// http-swagger documents a route declared `@Get('/')` / `@Post('/')` with a trailing slash.
const openApiPath = (route: string) => route.slice(route.indexOf(' ') + 1).replace(/:(\w+)/g, '{$1}').replace(/^\/teams$/, '/teams/');
const verb = (route: string) => route.slice(0, route.indexOf(' ')).toLowerCase();
const AUTHENTICATED_ONLY = ['POST /invitations/accept', 'GET /user/teams'];

function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else refs(v, out);
    }
  }
  return out;
}

describe('teams-http swagger', function () {
  this.timeout(60_000);

  let doc: any;

  before(async () => {
    const listed = await (await DI.resolve(Controllers)).Controllers;
    const cache = await DI.resolve(SwaggerDocCache);
    const builder = await DI.resolve(OpenApiBuilder, [{ enabled: true, title: 'test', version: '1' }]);
    for (const c of TEAMS_HTTP_CONTROLLERS) {
      const info = listed.find((i) => i.name === c.name);
      expect(info, `${c.name} is registered`).to.not.eq(undefined);
      const entry = { ...info!, file: compiled(c.name) };
      builder.addController(entry, await cache.getCache(entry));
    }
    doc = builder.build() as IOpenApiDocument;
  });

  it("documents every route with a summary under its controller's tag", () => {
    const tags = ['Teams', 'Team members', 'Team groups', 'Groups', 'Team invitations', 'Invitations', 'User teams'];
    expect(doc.tags.map((t: any) => t.name)).to.include.members(tags);
    for (const route of TEAMS_HTTP_ROUTES) {
      const op = doc.paths[openApiPath(route)]?.[verb(route)];
      expect(op, route).to.not.eq(undefined);
      expect(op.summary, route).to.be.a('string').that.is.not.empty;
      expect(tags, route).to.include(op.tags[0]);
    }
  });

  it('carries the @Access permission on every guarded route and none on the authenticated-only ones', () => {
    for (const route of TEAMS_HTTP_ROUTES) {
      const op = doc.paths[openApiPath(route)][verb(route)];
      if (AUTHENTICATED_ONLY.includes(route)) expect(op['x-authz-permission'], route).to.eq(undefined);
      else expect(op['x-authz-permission'], route).to.be.an('array').that.is.not.empty;
    }
    const patch = doc.paths['/teams/{team}'].patch;
    expect(patch['x-authz-permission']).to.deep.eq(['team:update']);
    expect(patch['x-authz-resource']).to.deep.eq({ type: 'team', in: 'path', name: 'team' });
    expect(doc.paths['/teams/{team}/groups'].post['x-authz-permission']).to.deep.eq(['group:create']);
  });

  it('documents the request bodies from the @Schema classes', () => {
    const body = (path: string, method: string) => doc.paths[path][method].requestBody?.content['application/json'].schema;
    expect(body('/teams/', 'post').required).to.deep.eq(['slug', 'name']);
    expect(Object.keys(body('/teams/', 'post').properties)).to.have.members(['slug', 'name', 'description', 'parentId']);
    expect(body('/teams/{team}/members', 'post').properties.subject.pattern).to.eq('^[^:]+:.+$');
    expect(body('/teams/{team}/invitations', 'post').required).to.deep.eq(['role']);
    expect(body('/groups/{group}/move', 'post').required).to.deep.eq(['parentId']);
    expect(body('/invitations/accept', 'post').required).to.deep.eq(['token']);
    expect(body('/teams/{team}/transfer', 'post').properties.keepAs).to.include({ type: 'string', nullable: true });
    expect(body('/teams/{team}', 'delete')).to.eq(undefined);
  });

  it('documents the query parameters', () => {
    const query = (path: string) => Object.fromEntries(doc.paths[path].get.parameters.filter((p: any) => p.in === 'query').map((p: any) => [p.name, p]));
    expect(Object.keys(query('/teams/'))).to.have.members(['parentId', 'root', 'page', 'size']);
    for (const path of ['/teams/{team}/members', '/teams/{team}/groups', '/teams/{team}/invitations', '/groups/{group}/members']) {
      expect(Object.keys(query(path)), path).to.have.members(['page', 'size']);
      expect(query(path).size.schema, path).to.include({ minimum: 1, maximum: 200 });
    }
  });

  it('refers the answers to the Teams* components, and every $ref resolves', () => {
    const answer = (path: string, method: string, status = '200') => doc.paths[path][method].responses[status].content['application/json'].schema.$ref;
    expect(answer('/teams/', 'get')).to.eq('#/components/schemas/TeamsTeamPage');
    expect(answer('/teams/{team}', 'get')).to.eq('#/components/schemas/TeamsTeam');
    expect(answer('/teams/{team}/members', 'get')).to.eq('#/components/schemas/TeamsMemberPage');
    expect(answer('/teams/{team}/invitations', 'post')).to.eq('#/components/schemas/TeamsInvitationCreated');
    expect(answer('/invitations/accept', 'post', '409')).to.eq('#/components/schemas/TeamsError');
    expect(answer('/user/teams', 'get')).to.eq('#/components/schemas/TeamsUserTeams');
    expect(doc.components.schemas.TeamsInvitation.properties).to.not.have.any.keys('token', 'tokenHash');
    for (const ref of refs(doc.paths)) {
      const [, , kind, name] = ref.split('/');
      expect(doc.components[kind], ref).to.have.property(name);
    }
    for (const name of Object.keys(TEAMS_HTTP_SCHEMAS)) expect(name).to.match(/^Teams[A-Z]/);
  });
});
