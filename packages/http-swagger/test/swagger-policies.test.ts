import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

describe('Swagger policy extraction', function () {
  this.timeout(30000);

  let spec: any;

  before(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);

    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Controllers);

    const server = await DI.resolve<HttpServer>(HttpServer);
    server.start();

    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    spec = JSON.parse(result.text);
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  it('should expose x-policies for routes inheriting controller-level @Policy', () => {
    const op = spec.paths['/policies/inherited'].get;
    expect(op['x-policies']).to.deep.equal(['AuthorizedTestPolicy']);
  });

  it('should merge controller-level and route-level policies (controller first)', () => {
    const op = spec.paths['/policies/combined'].get;
    expect(op['x-policies']).to.deep.equal(['AuthorizedTestPolicy', 'OffHoursTestPolicy']);
  });

  it('should NOT set x-policies on controllers without any @Policy decorators', () => {
    const op = spec.paths['/pets/'].get;
    expect(op['x-policies']).to.be.undefined;
  });

  it('should append a "Policies applied:" block to operation descriptions', () => {
    const op = spec.paths['/policies/combined'].get;
    expect(op.description).to.match(/\*\*Policies applied:\*\*/);
    expect(op.description).to.include('`AuthorizedTestPolicy`');
    expect(op.description).to.include('`OffHoursTestPolicy`');
  });

  it('should mark controller-level policies with the (controller) scope label', () => {
    const op = spec.paths['/policies/combined'].get;
    expect(op.description).to.match(/AuthorizedTestPolicy.*\(controller\)/);
  });

  it('should render a "Policies" reference section in info.description', () => {
    expect(spec.info.description).to.match(/^|##\s+Policies/m);
    expect(spec.info.description).to.include('AuthorizedTestPolicy');
    expect(spec.info.description).to.include('OffHoursTestPolicy');
  });

  it('should extract JSDoc descriptions of documented policies into the Policies section', () => {
    expect(spec.info.description).to.match(/fully authorized/i);
    expect(spec.info.description).to.match(/business hours/i);
  });

  it('should emit the fallback message for policies without JSDoc', () => {
    const op = spec.paths['/policies/undocumented'].get;
    expect(op['x-policies']).to.include('UndocumentedTestPolicy');
    expect(spec.info.description).to.match(/No description available/i);
  });

  it('should anchor each policy in info.description with a stable id', () => {
    expect(spec.info.description).to.match(/<a id="policy-authorizedtestpolicy">/);
    expect(spec.info.description).to.match(/<a id="policy-offhourstestpolicy">/);
  });

  it('should link operation descriptions to the policies section', () => {
    const op = spec.paths['/policies/combined'].get;
    expect(op.description).to.include('#policy-authorizedtestpolicy');
    expect(op.description).to.include('#policy-offhourstestpolicy');
  });
});
