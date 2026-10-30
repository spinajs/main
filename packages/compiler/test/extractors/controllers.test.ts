import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractControllers } from '../../src/index.js';

describe('extractControllers', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('controller.ts'))!;
  const [users] = extractControllers(ctx, file);
  const route = (h: string) => users.routes.find((r) => r.handler === h)!;

  it('controller shell', () => {
    expect(users).to.deep.include({ id: 'pkg-basic:UsersController', className: 'UsersController', basePath: 'users', policies: [[{ type: 'AdminPolicy', options: ['strict'] }]], middlewares: [{ type: 'Audit', options: [] }] });
    expect(users.source).to.deep.equal({ file: 'src/controller.ts', line: 11, col: 1, package: 'pkg-basic' });
    expect(users.routes.map((r) => r.handler)).to.deep.equal(['get', 'create', 'remove', 'list', 'events', 'ping']);
    expect(users).to.not.have.property('access');
    expect(users).to.not.have.property('allowAnonymous');
  });
  it('GET :id with path and query params, Access, doc', () => {
    const r = route('get');
    expect(r).to.deep.include({ method: 'get', path: ':id', fullPath: '/users/:id', access: ['user:read'], policies: [[{ type: 'AccessPolicy', options: ['route'] }]] });
    expect(r.params).to.deep.equal([
      { index: 0, name: 'id', kind: 'FromParams', runtimeType: { text: 'number', schema: 'spinajs/pkg-basic/UsersController_get_id' }, required: true },
      { index: 1, name: 'verbose', kind: 'FromQuery', runtimeType: { text: 'boolean', schema: 'spinajs/pkg-basic/UsersController_get_verbose' }, required: false },
    ]);
    expect(r.returnType).to.deep.equal({ text: 'UserDto', schema: 'spinajs/pkg-basic/UserDto' });
    expect(r.doc).to.deep.equal({ summary: 'Get one user', tags: ['users'], responses: [{ status: 404, description: 'not found' }] });
  });
  it('POST with required body, several permissions and options', () => {
    const r = route('create');
    expect(r.params[0]).to.deep.equal({ index: 0, name: 'body', kind: 'FromBody', runtimeType: { text: 'CreateUserDto', schema: 'spinajs/pkg-basic/CreateUserDto' }, required: true, options: { required: true } });
    expect(r.access).to.deep.equal(['user:create', 'user:update']);
    expect(r.middlewares).to.deep.equal([{ type: 'AuthzFieldsMiddleware', options: [] }]);
    expect(r.fullPath).to.equal('/users/create');
  });
  it('DELETE with inline schema hoisted, anonymous, policy group with config key', () => {
    const r = route('remove');
    expect(r.allowAnonymous).to.be.true;
    expect(r.policies).to.deep.equal([[{ type: 'AdminPolicy', options: [] }, { type: 'policies.admin', options: [] }]]);
    expect(r.params[0].schema).to.equal('spinajs/pkg-basic/UsersController.remove.id');
    expect(ctx.schemas['spinajs/pkg-basic/UsersController.remove.id']).to.deep.equal({ type: 'number', minimum: 1 });
    expect(r.returnType).to.deep.equal({ text: 'void' });
  });
  it('records derived schemas for body, query params and the response', () => {
    const body = route('create').params.find((p) => p.kind === 'FromBody')!;
    expect(body.runtimeType.schema).to.equal('spinajs/pkg-basic/CreateUserDto');
    expect(ctx.schemaRegistry.get('spinajs/pkg-basic/CreateUserDto')).to.deep.include({ type: 'object' });
    const list = route('list');
    expect(list.returnType.text).to.equal('UserDto[]');
    expect(list.returnType.schema).to.equal('spinajs/pkg-basic/UsersController_list_Response');
    expect(ctx.schemaRegistry.get('spinajs/pkg-basic/UsersController_list_Response')).to.deep.equal({
      $id: 'spinajs/pkg-basic/UsersController_list_Response',
      type: 'array',
      items: { $ref: 'spinajs/pkg-basic/UserDto' },
    });
  });
  it('leaves schema unset for void responses and bare wrappers', () => {
    expect(route('remove').returnType).to.deep.equal({ text: 'void' });
    expect(route('ping').returnType).to.deep.equal({ text: 'Ok' });
  });
  it('class-level Access and AllowAnonymous land on the controller, not the route', () => {
    const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
    const unitCtx = createContext(unit, 'unit', 'test/fixtures/unit');
    const [open] = extractControllers(unitCtx, unit.sourceFiles.find((f) => f.fileName.endsWith('class-access.ts'))!);
    expect(open.access).to.deep.equal(['admin:all']);
    expect(open.allowAnonymous).to.be.true;
    expect(open.policies).to.deep.equal([[{ type: 'AccessPolicy', options: ['class'] }]]);
    expect(open.routes[0]).to.not.have.property('access');
    expect(open.routes[0]).to.not.have.property('allowAnonymous');
    expect(open.routes[0].fullPath).to.equal('/open/ping');
  });
});
