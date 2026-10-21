import { RuleTester } from '@typescript-eslint/rule-tester';

import { requireAccess } from '../src/rules/require-access.js';

// RuleTester finds mocha's describe/it as globals; only the teardown hook has another name.
RuleTester.afterAll = after;

const ruleTester = new RuleTester();

const imports = "import { Access, AllowAnonymous, BasePath, BaseController, Del, Get, Head, Patch, Policy, Post, Put, Unscoped } from './http';\n";
const code = (body: string) => `${imports}${body}\n`;

const unguarded = (controller: string, method: string) => ({ messageId: 'unguardedRoute' as const, data: { controller, method } });

ruleTester.run('require-access', requireAccess, {
  valid: [
    code("class C extends BaseController { @Get() @Access('file:read') public read() {} }"),
    code("class C extends BaseController { @Get('/x') @Policy(IsAuthenticated) public read() {} }"),
    code('class C extends BaseController { @Get() @AllowAnonymous() public read() {} }'),
    code("@Access('file:read') class C extends BaseController { @Get() public read() {} @Post() public write() {} }"),
    code('@Policy(IsAuthenticated) class C extends BaseController { @Get() public read() {} }'),
    code('@AllowAnonymous() class C extends BaseController { @Get() public read() {} }'),
    code("@BasePath('c') @Access('file:read') class C extends BaseController { @Get() public read() {} }"),
    code("class C extends BaseController { @Post('/x', schema) @Access(['a:b', 'c:d'], { domain: 'fs' }) public write() {} }"),
    code("class C extends BaseController { @Access('file:read') @Del() public remove() {} }"),
    code("class C extends BaseController { @authz.Access('file:read') @http.Get() public read() {} }"),
    code('class C extends BaseController { @Get() @AllowAnonymous public read() {} }'),
    code('class C extends BaseController { public helper() {} @Cached() public cached() {} }'),
    code('class C { public read() {} }'),
    code("export default class extends BaseController { @Get() @Access('file:read') public read() {} }"),
    {
      code: code('class C extends BaseController { @Get() @Authenticated() public read() {} }'),
      options: [{ guardDecorators: ['Authenticated'] }],
    },
    {
      code: code('@Authenticated() class C extends BaseController { @Get() public read() {} }'),
      options: [{ guardDecorators: ['Authenticated'] }],
    },
    {
      code: code('class C extends BaseController { @Mount() public read() {} }'),
      options: [{ guardDecorators: ['Authenticated'] }],
    },
  ],
  invalid: [
    { code: code('class C extends BaseController { @Get() public read() {} }'), errors: [unguarded('C', 'read')] },
    { code: code("class C extends BaseController { @Get('/x') public read() {} }"), errors: [unguarded('C', 'read')] },
    { code: code('class C extends BaseController { @Get public read() {} }'), errors: [unguarded('C', 'read')] },
    { code: code("@BasePath('c') class C extends BaseController { @Post() public write() {} }"), errors: [unguarded('C', 'write')] },
    { code: code('class C extends BaseController { @Put() public a() {} @Patch() public b() {} @Del() public c() {} @Head() public d() {} }'), errors: [unguarded('C', 'a'), unguarded('C', 'b'), unguarded('C', 'c'), unguarded('C', 'd')] },
    {
      code: code("class C extends BaseController { @Get() @Access('file:read') public read() {} @Post() public write() {} }"),
      errors: [unguarded('C', 'write')],
    },
    { code: code("class C extends BaseController { @Get() @Unscoped('export') public read() {} }"), errors: [unguarded('C', 'read')] },
    { code: code('class C extends BaseController { @http.Get() public read() {} }'), errors: [unguarded('C', 'read')] },
    { code: code("class C extends BaseController { @Get() public 'read-all'() {} }"), errors: [unguarded('C', 'read-all')] },
    { code: code("export default class extends BaseController { @Get() public read() {} }"), errors: [unguarded('<anonymous>', 'read')] },
    { code: code('const C = class extends BaseController { @Get() public read() {} };'), errors: [unguarded('C', 'read')] },
    {
      code: code('class C extends BaseController { @Mount() public read() {} }'),
      options: [{ routeDecorators: ['Mount'] }],
      errors: [unguarded('C', 'read')],
    },
    {
      code: code('class C extends BaseController { @Get() @Authenticated() public read() {} }'),
      errors: [unguarded('C', 'read')],
    },
  ],
});
