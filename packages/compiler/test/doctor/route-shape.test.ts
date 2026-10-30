import 'mocha';
import { expect } from 'chai';
import type { ParamEntry } from '@spinajs/manifest';
import { ambiguousBody, doubleSlashPath, shadowedRoute } from '../../src/doctor/rules/index.js';
import { createProgramFromTsconfig, createContext, extractControllers } from '../../src/index.js';
import { fixture, controller, route, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

const body = (name: string, schema: string | undefined, wire: ParamEntry['wire']): ParamEntry => ({ index: 0, name, kind: 'FromBody', runtimeType: { text: 'Dto', ...(schema ? { schema } : {}) }, required: true, ...(wire ? { wire } : {}) });

describe('HTTP003 double-slash-path', () => {
  it("reports every route whose request path keeps a // from a leading or trailing slash, not the root route under @BasePath('/')", () => {
    const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
    const controllers = extractControllers(createContext(unit, 'unit', 'test/fixtures/unit'), unit.sourceFiles.find((f) => f.fileName.endsWith('route-paths.ts'))!);
    expect(doubleSlashPath.run(fixture({ controllers }), ctx).map((d) => [d.code, d.severity, d.message])).to.deep.equal([
      ['HTTP003', 'warning', "UsersPathController.leadingSlash is mounted at /users//slash, not /users/slash: @spinajs/http keeps the slashes of @BasePath and the route path as written. Remove the leading slash from the route path ('/slash')."],
      ['HTTP003', 'warning', "RootController.bare is mounted at ///bare, not /bare: @spinajs/http keeps the slashes of @BasePath and the route path as written. Under @BasePath('/'), give the route an explicit path."],
      ['HTTP003', 'warning', "LeadingSlashBaseController.x is mounted at //lead/x, not /lead/x: @spinajs/http keeps the slashes of @BasePath and the route path as written. Remove the outer slashes from @BasePath ('/lead')."],
    ]);
  });

  it('leaves clean paths alone', () => {
    const m = fixture({ controllers: [controller({ className: 'Users', basePath: 'users', routes: [route({ handler: 'list', fullPath: '/users/list' }), route({ handler: 'root', path: '/', fullPath: '/users' })] })] });
    expect(doubleSlashPath.run(m, ctx)).to.deep.equal([]);
  });
});

describe('HTTP004 shadowed-route', () => {
  it('reports a literal route declared after a parameterised route that matches it', () => {
    const m = fixture({
      controllers: [
        controller({
          className: 'Users',
          routes: [route({ handler: 'get', fullPath: '/users/:id' }), route({ handler: 'slash', fullPath: '/users/Slash', source: src('src/users.ts', 20) }), route({ handler: 'create', method: 'post', fullPath: '/users/slash' })],
        }),
      ],
    });
    expect(shadowedRoute.run(m, ctx)).to.deep.equal([
      { code: 'HTTP004', severity: 'warning', message: 'Users.slash (GET /users/Slash) is never reached: Users.get (/users/:id) is declared first and matches the same requests. Declare Users.slash first.', source: src('src/users.ts', 20) },
    ]);
  });

  it('reports a HEAD route that an earlier GET route answers, the same path included', () => {
    const m = fixture({
      controllers: [
        controller({
          className: 'Files',
          routes: [
            route({ handler: 'get', fullPath: '/files/:id' }),
            route({ handler: 'probe', method: 'head', fullPath: '/files/x', source: src('src/files.ts', 7) }),
            route({ handler: 'list', fullPath: '/files' }),
            route({ handler: 'count', method: 'head', fullPath: '/files', source: src('src/files.ts', 9) }),
          ],
        }),
        controller({ className: 'Docs', routes: [route({ handler: 'head', method: 'head', fullPath: '/docs/x' }), route({ handler: 'get', fullPath: '/docs/:id' })] }),
      ],
    });
    expect(shadowedRoute.run(m, ctx).map((d) => [d.message, d.source?.line])).to.deep.equal([
      ['Files.probe (HEAD /files/x) is never reached: Files.get (GET /files/:id) is declared first and matches the same requests. Declare Files.probe first.', 7],
      ['Files.count (HEAD /files) is never reached: Files.list (GET /files) is declared first and matches the same requests. Declare Files.count first.', 9],
    ]);
  });

  it('accepts the literal route first, other segment counts and other controllers', () => {
    const m = fixture({
      controllers: [
        controller({ className: 'Users', routes: [route({ handler: 'slash', fullPath: '/users/slash' }), route({ handler: 'get', fullPath: '/users/:id' }), route({ handler: 'avatar', fullPath: '/users/:id/avatar' })] }),
        controller({ className: 'Other', routes: [route({ handler: 'x', fullPath: '/users/x' })] }),
      ],
    });
    expect(shadowedRoute.run(m, ctx)).to.deep.equal([]);
  });
});

describe('HTTP005 ambiguous-body', () => {
  const schemas = { 'spinajs/app/EmailDto': { type: 'object', properties: { email: { type: 'string' } } }, 'spinajs/app/Ref': { $ref: 'spinajs/app/EmailDto' } };

  it('reports a whole-body @Body whose type has a property with the parameter name', () => {
    const m = fixture({
      schemas,
      controllers: [
        controller({
          className: 'Mail',
          routes: [
            route({ handler: 'send', params: [body('email', 'spinajs/app/EmailDto', { in: 'body', shape: 'whole' })], source: src('src/mail.ts', 4) }),
            route({ handler: 'ref', params: [body('email', 'spinajs/app/Ref', { in: 'body', shape: 'whole' })], source: src('src/mail.ts', 8) }),
          ],
        }),
      ],
    });
    expect(ambiguousBody.run(m, ctx).map((d) => [d.code, d.severity, d.message, d.source?.line])).to.deep.equal([
      ['HTTP005', 'warning', "Mail.send binds @Body() email to the whole body, but Dto has a property 'email': a body carrying it binds body.email instead. Rename the parameter.", 4],
      ['HTTP005', 'warning', "Mail.ref binds @Body() email to the whole body, but Dto has a property 'email': a body carrying it binds body.email instead. Rename the parameter.", 8],
    ]);
  });

  it('reports a whole-body @AsModel the same way: AsDbModel reads body[name] first too', () => {
    const asModel = { ...body('email', 'spinajs/app/EmailDto', { in: 'body', shape: 'whole' }), kind: 'AsDbModel' };
    const header = { ...body('email', 'spinajs/app/EmailDto', { in: 'header', name: 'email', shape: 'json' }), kind: 'AsDbModel' };
    const m = fixture({ schemas, controllers: [controller({ className: 'Mail', routes: [route({ handler: 'model', params: [asModel] }), route({ handler: 'header', params: [header] })] })] });
    expect(ambiguousBody.run(m, ctx).map((d) => d.message)).to.deep.equal([
      "Mail.model binds @AsModel() email to the whole body, but Dto has a property 'email': a body carrying it binds body.email instead. Rename the parameter.",
    ]);
  });

  it('accepts other names, field bodies and bodies without a schema', () => {
    const m = fixture({
      schemas,
      controllers: [
        controller({
          className: 'Mail',
          routes: [
            route({ handler: 'a', params: [body('body', 'spinajs/app/EmailDto', { in: 'body', shape: 'whole' })] }),
            route({ handler: 'b', params: [body('email', 'spinajs/app/EmailDto', { in: 'body', name: 'email', shape: 'field' })] }),
            route({ handler: 'c', params: [body('email', undefined, { in: 'body', shape: 'whole' })] }),
          ],
        }),
      ],
    });
    expect(ambiguousBody.run(m, ctx)).to.deep.equal([]);
  });
});
