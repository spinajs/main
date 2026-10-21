import { RuleTester } from '@typescript-eslint/rule-tester';

import { noRawRequest } from '../src/rules/no-raw-request.js';

// RuleTester finds mocha's describe/it as globals; only the teardown hook has another name.
RuleTester.afterAll = after;

const ruleTester = new RuleTester();

const imports = "import { BaseController, Body, Get, Post, Query, Req, Res, Ok } from './http';\nimport { bodyField } from './fields';\n";
const code = (body: string) => `${imports}${body}\n`;

const rawArg = (controller: string, method: string, decorator = 'Req') => ({ messageId: 'rawRequestArg' as const, data: { controller, method, decorator } });
const rawBody = (controller: string, name = 'bodyField') => ({ messageId: 'rawBodyRead' as const, data: { controller, name } });

ruleTester.run('no-raw-request', noRawRequest, {
  valid: [
    code('class C extends BaseController { @Post() public login(@Body() body: LoginDto) { return new Ok(body); } }'),
    code('class C extends BaseController { @Get() public list(@Query() q: ListQuery) {} }'),
    code('class Helper { public read(@Req() req: Request) { return bodyField(req, "x"); } }'),
    code('class Service { public read(req: Request) { return bodyField(req, "x"); } }'),
    code('export function readLogin(req: Request) { return bodyField(req, "login"); }'),
    code('class C extends BaseController { @Post() public login(@Body() body: LoginDto) {} }\nconst x = bodyField(req, "x");'),
    code('class Middleware extends RouteMiddleware { public onBefore(@Req() req: Request) {} }'),
    {
      code: code('class C extends BaseController { @Get() public list(@Session() s: unknown) {} }'),
      options: [{ decorators: ['Raw'] }],
    },
  ],
  invalid: [
    { code: code('class C extends BaseController { @Get() public read(@Req() req: Request) {} }'), errors: [rawArg('C', 'read')] },
    { code: code('class C extends BaseController { @Get() public read(@Res() res: Response) {} }'), errors: [rawArg('C', 'read', 'Res')] },
    { code: code('class C extends BaseController { @Get() public read(@Req req: Request) {} }'), errors: [rawArg('C', 'read')] },
    { code: code('class C extends BaseController { @Get() public read(@http.Req() req: Request) {} }'), errors: [rawArg('C', 'read')] },
    { code: code('class C extends http.BaseController { public read(@Req() req: Request) {} }'), errors: [rawArg('C', 'read')] },
    { code: code('class C extends AuthnBaseController { public read(@Req() req: Request) {} }'), errors: [rawArg('C', 'read')] },
    { code: code('class C { @Post() public write(@Body() b: Dto, @Req() req: Request, @Res() res: Response) {} }'), errors: [rawArg('C', 'write'), rawArg('C', 'write', 'Res')] },
    { code: code('const C = class extends BaseController { public read(req: Request) { return bodyField(req, "x"); } };'), errors: [rawBody('C')] },
    { code: code("export default class extends BaseController { @Get() public 'read-all'(@Req() req: Request) {} }"), errors: [rawArg('<anonymous>', 'read-all')] },
    { code: code('class C extends BaseController { @Post() public login(@Req() req: Request) { return bodyField(req, "login"); } }'), errors: [rawArg('C', 'login'), rawBody('C')] },
    { code: code('class C extends BaseController { protected login(req: Request) { return fields.bodyField(req, "login"); } }'), errors: [rawBody('C')] },
    { code: code('class C extends BaseController { @Post() public login() { const read = () => bodyField(this.req, "x"); return read(); } }'), errors: [rawBody('C')] },
    {
      code: code('class C extends BaseController { @Get() public list(@Raw() r: unknown) { return readBody(r); } }'),
      options: [{ decorators: ['Raw'], functions: ['readBody'] }],
      errors: [rawArg('C', 'list', 'Raw'), rawBody('C', 'readBody')],
    },
  ],
});
