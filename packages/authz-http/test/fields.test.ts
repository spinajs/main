import 'mocha';
import { expect } from 'chai';
import type { DecisionRequest } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, Body, BodyField, Get, Ok, Patch, Policy, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { testHost } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { Access, AuthzFieldTransformer, UnfilteredInput, fromParam } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';

const D = 'fld';
const ROW = { id: 'u1', name: 'N', email: 'e@example.com', salary: 9, Password: 'hash', address: { city: 'C', zip: 'Z' } };
const USER = fromParam('id', 'user');

const script = { read: ['id', 'name', 'email', 'address.city'] as string[], write: ['name', 'address.city'] as string[] };

const votes = (req: DecisionRequest): ScriptedVote => {
  if (req.principal.id !== 'alice') return {};
  if (req.permission === 'user:read') return { permitWhen: { op: 'true' }, fields: { read: script.read } };
  if (req.permission === 'user:update') return { permitWhen: { op: 'true' }, fields: { write: script.write } };
  return { permitWhen: { op: 'true' } };
};

class Passes extends BasePolicy {
  public isEnabled() {
    return true;
  }
  public async execute() {}
}

@BasePath('fld')
class FieldRoutes extends BaseController {
  @Get('users/:id')
  @Access('user:read', { domain: D, resource: USER, fields: 'filter' })
  public read() {
    return new Ok(structuredClone(ROW));
  }

  @Get('raw/:id')
  @Access('user:read', { domain: D, resource: USER })
  public raw() {
    return new Ok(structuredClone(ROW));
  }

  @Get('list')
  @Access('user:read', { domain: D, fields: 'filter' })
  public list() {
    return new Ok([structuredClone(ROW), Promise.resolve(structuredClone(ROW))]);
  }

  @Patch('users/:id')
  @Access('user:update', { domain: D, resource: USER })
  public update(@Body() body: object) {
    return new Ok({ body });
  }

  @Patch('users/:id/fields')
  @Access('user:update', { domain: D, resource: USER })
  public updateFields(@Body() name: string, @Body() salary: number) {
    return new Ok({ name: name ?? null, salary: salary ?? null });
  }

  @Patch('field/:id')
  @Access('user:update', { domain: D, resource: USER })
  public bodyField(@BodyField() body: object) {
    return new Ok({ body });
  }

  @Patch('admin/:id')
  @Access('user:update', { domain: D, resource: USER })
  @UnfilteredInput('admins set passwords')
  public admin(@Body() body: object) {
    return new Ok({ body });
  }

  @Patch('open/:id')
  public open(@Body() body: object) {
    return new Ok({ body });
  }

  @Get('alt/:id')
  @Access('user:read', { domain: D, resource: USER, fields: 'filter' })
  @Policy(Passes)
  public alternative() {
    return new Ok(structuredClone(ROW));
  }

  @Patch('alt/:id')
  @Access('user:update', { domain: D, resource: USER })
  @Policy(Passes)
  public alternativeWrite(@Body() body: object) {
    return new Ok({ body });
  }

  @Get('transform')
  @Access('user:read', { domain: D })
  public transform(@Req() req: Request) {
    return new Ok(new AuthzFieldTransformer().transform(structuredClone(ROW), req));
  }
}

describe('field filters (B17 http)', function () {
  this.timeout(30000);

  let app: TestApp;
  let domain: TestDomain;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [FieldRoutes] });
    domain = await createDomain(D, { permissions: { 'user:read': { fields: true }, 'user:update': { fields: true } }, model: { votes, capabilities: { fields: true } } });
  });

  after(async () => {
    await domain?.dispose();
    await stopApp();
    unregisterSource();
  });

  afterEach(() => {
    script.read = ['id', 'name', 'email', 'address.city'];
    script.write = ['name', 'address.city'];
    testHost.config().unset(['authz', 'domains', D, 'fields']);
  });

  const reject = () => testHost.config().set(['authz', 'domains', D, 'fields'], { write: { mode: 'reject' } });

  describe('output', () => {
    it("@Access(…, { fields: 'filter' }) keeps only readable fields, nested ones included", async () => {
      const res = await app.request().get('/fld/users/u1').set('x-user', 'alice');

      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ id: 'u1', name: 'N', email: 'e@example.com', address: { city: 'C' } });
    });

    it('drops authz.fields.neverRead even under *', async () => {
      script.read = ['*'];
      const res = await app.request().get('/fld/users/u1').set('x-user', 'alice');

      expect(res.body).to.include({ name: 'N', salary: 9 });
      expect(res.body).to.not.have.property('Password');
    });

    it('filters every element of a list, promises resolved', async () => {
      const res = await app.request().get('/fld/list').set('x-user', 'alice');

      expect(res.body).to.have.length(2);
      for (const row of res.body) expect(row).to.not.have.property('salary');
    });

    it("leaves the response alone without fields: 'filter'", async () => {
      const res = await app.request().get('/fld/raw/u1').set('x-user', 'alice');

      expect(res.body).to.have.property('salary', 9);
    });

    it('drops neverRead from a response another policy group admitted', async () => {
      const res = await app.request().get('/fld/alt/u1').set('x-user', 'carol');

      expect(res.status).to.eq(200);
      expect(res.body).to.have.property('salary', 9);
      expect(res.body).to.not.have.property('Password');
    });

    it('AuthzFieldTransformer applies the same filter to data it is given', async () => {
      const res = await app.request().get('/fld/transform').set('x-user', 'alice');

      expect(res.body).to.not.have.property('salary');
      expect(res.body).to.have.property('name', 'N');
    });
  });

  describe('input', () => {
    it('strips body fields outside fields.write, nested ones included', async () => {
      const res = await app.request().patch('/fld/users/u1').set('x-user', 'alice').send({ name: 'M', salary: 10, address: { city: 'X', zip: 'Y' } });

      expect(res.status).to.eq(200);
      expect(res.body.body).to.deep.eq({ name: 'M', address: { city: 'X' } });
    });

    it("answers 400 naming the fields in 'reject' mode", async () => {
      reject();
      const res = await app.request().patch('/fld/users/u1').set('x-user', 'alice').send({ name: 'M', salary: 10, address: { zip: 'Y' } });

      expect(res.status).to.eq(400);
      expect(res.body.fields).to.have.members(['salary', 'address.zip']);
    });

    it("lets writable input through in 'reject' mode", async () => {
      reject();
      const res = await app.request().patch('/fld/users/u1').set('x-user', 'alice').send({ name: 'M' });

      expect(res.status).to.eq(200);
      expect(res.body.body).to.deep.eq({ name: 'M' });
    });

    it('strips authz.fields.neverRead even under write *, and 400 in reject mode', async () => {
      script.write = ['*'];
      const strip = await app.request().patch('/fld/users/u1').set('x-user', 'alice').send({ name: 'M', Password: 'new' });
      expect(strip.body.body).to.deep.eq({ name: 'M' });

      reject();
      expect((await app.request().patch('/fld/users/u1').set('x-user', 'alice').send({ name: 'M', Password: 'new' })).status).to.eq(400);
    });

    it('filters @BodyField() input too', async () => {
      const res = await app.request().patch('/fld/field/u1').set('x-user', 'alice').send({ name: 'M', salary: 10 });

      expect(res.body.body).to.deep.eq({ name: 'M' });
    });

    it('leaves the input of an @UnfilteredInput route and of a route without @Access alone', async () => {
      expect((await app.request().patch('/fld/admin/u1').set('x-user', 'alice').send({ name: 'M', Password: 'p' })).body.body).to.deep.eq({ name: 'M', Password: 'p' });
      expect((await app.request().patch('/fld/open/u1').send({ name: 'M', Password: 'p' })).body.body).to.deep.eq({ name: 'M', Password: 'p' });
    });

    it('strips neverRead from a request another policy group admitted', async () => {
      const res = await app.request().patch('/fld/alt/u1').set('x-user', 'carol').send({ name: 'M', salary: 1, Password: 'p' });

      expect(res.status).to.eq(200);
      expect(res.body.body).to.deep.eq({ name: 'M', salary: 1 });
    });

    it('checks a primitive-typed parameter by its name even when the value is an object', async () => {
      const res = await app.request().patch('/fld/users/u1/fields').set('x-user', 'alice').send({ name: 'M', salary: { a: 1 } });

      expect(res.body.salary).to.eq(null);
    });

    it('checks a named primitive body field by its name', async () => {
      const res = await app.request().patch('/fld/users/u1/fields').set('x-user', 'alice').send({ name: 'M', salary: 10 });

      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ name: 'M', salary: null });

      reject();
      expect((await app.request().patch('/fld/users/u1/fields').set('x-user', 'alice').send({ name: 'M', salary: 10 })).status).to.eq(400);
    });
  });
});
