import * as chai from 'chai';
import 'mocha';

import { AccessDenied } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Forbidden, InvalidArgument } from '@spinajs/exceptions';
import { FileUploadMiddleware } from '@spinajs/http';
import type { IUploadOptions, IUploadedFile } from '@spinajs/http';

import { AuthzUploadMiddleware } from '../src/index.js';
import type { AuthzUploadMiddlewareOptions } from '../src/index.js';
import { configuredChild } from './helpers.js';
import { FakeAuthz } from './support/fake-authz.js';
import { installQuietLog } from './support/log.js';

const expect = chai.expect;

const DEFAULT_FS = '__file_upload_default_provider__';

const upload = (baseName = 'upload_7f3a'): IUploadedFile => ({ Size: 3, Name: 'photo.png', BaseName: baseName, Type: 'image/png', Provider: null, OriginalFile: {} as IUploadedFile['OriginalFile'] });

const alice = userPrincipal('alice');

describe('authz-fs AuthzUploadMiddleware', function () {
  this.timeout(20000);

  let child: IContainer;
  let warnings: string[];
  let domains: string[];
  let undoLog: () => void;

  const middleware = (authz: FakeAuthz, extra: Partial<AuthzUploadMiddlewareOptions> = {}): AuthzUploadMiddleware =>
    new AuthzUploadMiddleware({
      container: child,
      service: async (domain) => (domains.push(domain), authz),
      principal: () => alice,
      log: { warn: (m: string) => warnings.push(m) },
      ...extra,
    });

  const refusal = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (e) {
      return e;
    }
    throw new Error('expected a rejection');
  };

  before(() => {
    undoLog = installQuietLog();
  });

  after(() => {
    undoLog();
  });

  beforeEach(async () => {
    child = await configuredChild({
      uploads: { mode: 'enforce' },
      invoices: { mode: 'audit' },
      scratch: { mode: 'off' },
      files: { mode: 'enforce', domain: 'files' },
      [DEFAULT_FS]: { mode: 'enforce' },
    });
    warnings = [];
    domains = [];
  });

  afterEach(async () => {
    await child.dispose();
  });

  it('is a FileUploadMiddleware that apps name in http.upload.middlewares', () => {
    expect(new AuthzUploadMiddleware()).to.be.instanceOf(FileUploadMiddleware);
    expect(DI.getRegisteredTypes(FileUploadMiddleware)).to.include(AuthzUploadMiddleware);
    expect(DI.getRegisteredTypes('AuthzUploadMiddleware')).to.include(AuthzUploadMiddleware);
  });

  it('allowed: checks fs:write on the file the uploader writes, with its row, and returns the file unchanged', async () => {
    const authz = new FakeAuthz();
    const file = upload();
    const out = await middleware(authz).beforeUpload(file, { fs: 'uploads' });
    expect(out).to.equal(file);
    expect(file).to.deep.equal(upload());
    expect(authz.calls.map((c) => [c.kind, c.principal, c.permission, c.resource, c.subject])).to.deep.equal([['assert', 'alice', 'fs:write', 'file:uploads:upload_7f3a', { id: 'uploads:upload_7f3a', type: 'file', fs: 'uploads', path: 'upload_7f3a' }]]);
    expect(domains).to.deep.equal(['root']);
  });

  it("asks the filesystem's domain", async () => {
    const authz = new FakeAuthz();
    await middleware(authz).beforeUpload(upload(), { fs: 'files' });
    expect(domains).to.deep.equal(['files']);
    expect(authz.keys()).to.deep.equal(['fs:write file:files:upload_7f3a']);
  });

  it('denied in enforce: AccessDenied, which http answers with 403 (a Forbidden)', async () => {
    const error = await refusal(() => middleware(new FakeAuthz(() => false)).beforeUpload(upload(), { fs: 'uploads' }));
    expect(error).to.be.instanceOf(AccessDenied);
    expect(error).to.be.instanceOf(Forbidden);
  });

  it('a conditional fs:write is a denial in enforce (D13)', async () => {
    const error = await refusal(() => middleware(new FakeAuthz(() => 'conditional')).beforeUpload(upload(), { fs: 'uploads' }));
    expect(error).to.be.instanceOf(AccessDenied);
    expect((error as AccessDenied).decision.reason?.code).to.equal('needs_subject');
  });

  it('audit: a denial or a conditional answer warns and lets the upload through', async () => {
    for (const answer of [false, 'conditional'] as const) {
      warnings = [];
      const file = upload();
      const authz = new FakeAuthz(() => answer);
      expect(await middleware(authz).beforeUpload(file, { fs: 'invoices' })).to.equal(file);
      expect(authz.calls.map((c) => c.kind)).to.deep.equal(['check']);
      expect(warnings, String(answer)).to.have.length(1);
      expect(warnings[0]).to.match(/^authz\.fs\.invoices: user:alice lacks fs:write on file:invoices:upload_7f3a/);
    }
  });

  it("mode 'off' or no entry: no check", async () => {
    const authz = new FakeAuthz(() => false);
    for (const fs of ['scratch', 'plain']) {
      const file = upload();
      expect(await middleware(authz).beforeUpload(file, { fs })).to.equal(file);
    }
    expect(authz.calls).to.deep.equal([]);
    expect(domains).to.deep.equal([]);
  });

  it('checks the filesystem the uploader copies to: file.Provider when set, before options.fs', async () => {
    const authz = new FakeAuthz();
    await middleware(authz).beforeUpload({ ...upload(), Provider: { Name: 'invoices' } as IUploadedFile['Provider'] }, { fs: 'uploads' });
    expect(authz.keys()).to.deep.equal(['fs:write file:invoices:upload_7f3a']);
    expect(authz.calls.map((c) => c.kind)).to.deep.equal(['check']);
  });

  it(`without options.fs it checks the default upload filesystem ${DEFAULT_FS}, as FromFile does`, async () => {
    for (const options of [undefined, {}, { fs: '' }] as (IUploadOptions | undefined)[]) {
      const authz = new FakeAuthz();
      await middleware(authz).beforeUpload(upload(), options);
      expect(authz.keys(), JSON.stringify(options)).to.deep.equal([`fs:write file:${DEFAULT_FS}:upload_7f3a`]);
    }
  });

  it('checks the normalised name and refuses one that leaves the filesystem or has none, before any check', async () => {
    const authz = new FakeAuthz();
    await middleware(authz).beforeUpload(upload('./a\\b.png'), { fs: 'uploads' });
    expect(authz.keys()).to.deep.equal(['fs:write file:uploads:a/b.png']);

    for (const name of ['../x.png', 'a/../../x.png', '', '.', 'x\0y']) {
      const denied = new FakeAuthz();
      const error = await refusal(() => middleware(denied).beforeUpload(upload(name), { fs: 'uploads' }));
      expect(error, JSON.stringify(name)).to.be.instanceOf(InvalidArgument);
      expect(denied.calls).to.deep.equal([]);
    }
  });

  it('reads the principal through the principal option', async () => {
    const authz = new FakeAuthz();
    await middleware(authz, { principal: () => userPrincipal('bob') }).beforeUpload(upload(), { fs: 'uploads' });
    expect(authz.calls.map((c) => c.principal)).to.deep.equal(['bob']);
  });
});
