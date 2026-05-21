import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

describe('Swagger API', function () {
  this.timeout(30000);

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
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  describe('GET /docs/swagger.json', function () {
    it('should return valid OpenAPI 3.0 document', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();

      expect(result).to.have.status(200);

      const spec = JSON.parse(result.text);
      expect(spec.openapi).to.equal('3.0.3');
      expect(spec.info).to.be.an('object');
      expect(spec.paths).to.be.an('object');
    });

    it('should contain correct info from configuration', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      expect(spec.info.title).to.equal('Test Pet Store API');
      expect(spec.info.version).to.equal('2.0.0');
      expect(spec.info.description).to.equal('A test API for swagger generation');
    });

    it('should contain servers from configuration', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      expect(spec.servers).to.be.an('array');
      expect(spec.servers).to.have.length(1);
      expect(spec.servers[0].url).to.equal('http://localhost:4557');
    });

    it('should contain paths for registered controllers', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      // Pet controller routes
      expect(spec.paths).to.have.property('/pets/');
      expect(spec.paths).to.have.property('/pets/{id}');

      // Status controller routes
      expect(spec.paths).to.have.property('/status/health');
      expect(spec.paths).to.have.property('/status/version');
    });

    it('should map HTTP methods correctly', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      expect(spec.paths['/pets/']).to.have.property('get');
      expect(spec.paths['/pets/']).to.have.property('post');
      expect(spec.paths['/pets/{id}']).to.have.property('get');
      expect(spec.paths['/pets/{id}']).to.have.property('put');
      expect(spec.paths['/pets/{id}']).to.have.property('delete');
      expect(spec.paths['/pets/{id}']).to.have.property('patch');
    });

    it('should include operation summaries from JSDoc', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const listPets = spec.paths['/pets/'].get;
      expect(listPets.summary).to.equal('List all pets');

      const getPet = spec.paths['/pets/{id}'].get;
      expect(getPet.summary).to.equal('Get a pet by ID');

      const createPet = spec.paths['/pets/'].post;
      expect(createPet.summary).to.equal('Create a new pet');
    });

    it('should include operation descriptions from JSDoc', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const listPets = spec.paths['/pets/'].get;
      expect(listPets.description).to.include('paginated list');

      const getPet = spec.paths['/pets/{id}'].get;
      expect(getPet.description).to.include('detailed information');
    });

    it('should mark deprecated operations from JSDoc @deprecated', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const deletePet = spec.paths['/pets/{id}'].delete;
      expect(deletePet.deprecated).to.equal(true);
    });

    it('should include tags from JSDoc @tags', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      // Tags array at top level
      expect(spec.tags).to.be.an('array');
      expect(spec.tags.length).to.be.greaterThan(0);

      // Patch has explicit @tags
      const patchPet = spec.paths['/pets/{id}'].patch;
      expect(patchPet.tags).to.include('Pets');
    });

    it('should include query parameters', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const listPets = spec.paths['/pets/'].get;
      expect(listPets.parameters).to.be.an('array');

      const pageParam = listPets.parameters.find((p: any) => p.name === 'page');
      expect(pageParam).to.exist;
      expect(pageParam.in).to.equal('query');

      const limitParam = listPets.parameters.find((p: any) => p.name === 'limit');
      expect(limitParam).to.exist;
      expect(limitParam.in).to.equal('query');
    });

    it('should include path parameters', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const getPet = spec.paths['/pets/{id}'].get;
      expect(getPet.parameters).to.be.an('array');

      const idParam = getPet.parameters.find((p: any) => p.name === 'id');
      expect(idParam).to.exist;
      expect(idParam.in).to.equal('path');
      expect(idParam.required).to.equal(true);
    });

    it('should include request body for POST operations', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const createPet = spec.paths['/pets/'].post;
      expect(createPet.requestBody).to.exist;
      expect(createPet.requestBody.content).to.have.property('application/json');
    });

    it('should include responses with status codes', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const getPet = spec.paths['/pets/{id}'].get;
      expect(getPet.responses).to.have.property('200');
      expect(getPet.responses).to.have.property('400');
      expect(getPet.responses).to.have.property('404');
      expect(getPet.responses).to.have.property('500');
    });

    it('should generate unique operationIds', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const operationIds = new Set<string>();
      for (const pathItem of Object.values(spec.paths)) {
        for (const operation of Object.values(pathItem as any)) {
          if ((operation as any).operationId) {
            expect(operationIds.has((operation as any).operationId)).to.be.false;
            operationIds.add((operation as any).operationId);
          }
        }
      }
    });

    it('should include parameter descriptions from JSDoc @param', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const listPets = spec.paths['/pets/'].get;
      const pageParam = listPets.parameters.find((p: any) => p.name === 'page');
      expect(pageParam.description).to.equal('Page number for pagination');

      const limitParam = listPets.parameters.find((p: any) => p.name === 'limit');
      expect(limitParam.description).to.equal('Number of items per page');
    });

    it('should infer inline object schema from TypeScript return type annotation', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const findPet = spec.paths['/pets/find/{name}'].get;
      const schema = findPet.responses['200'].content['application/json'].schema;

      expect(schema.type).to.equal('object');
      expect(schema.properties).to.have.property('id');
      expect(schema.properties.id.type).to.equal('number');
      expect(schema.properties).to.have.property('name');
      expect(schema.properties.name.type).to.equal('string');
      expect(schema.properties).to.have.property('available');
      expect(schema.properties.available.type).to.equal('boolean');
      expect(schema.required).to.include('id');
      expect(schema.required).to.include('name');
      expect(schema.required).to.include('available');
    });

    it('should infer array schema from TypeScript return type annotation', async () => {
      const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
      const spec = JSON.parse(result.text);

      const listAvailable = spec.paths['/pets/available'].get;
      const schema = listAvailable.responses['200'].content['application/json'].schema;

      expect(schema.type).to.equal('array');
      expect(schema.items).to.exist;
      expect(schema.items.type).to.equal('object');
      expect(schema.items.properties).to.have.property('id');
      expect(schema.items.properties.id.type).to.equal('number');
      expect(schema.items.properties).to.have.property('name');
      expect(schema.items.properties).to.have.property('type');
    });
  });

  describe('GET /docs/', function () {
    it('should return Swagger UI HTML page', async () => {
      const result = await req().get('docs/').set('Accept', 'text/html').send();

      expect(result).to.have.status(200);
      expect(result).to.have.header('content-type', /text\/html/);
      expect(result.text).to.include('swagger-ui');
      expect(result.text).to.include('SwaggerUIBundle');
    });

    it('should reference the spec URL in the HTML', async () => {
      const result = await req().get('docs/').set('Accept', 'text/html').send();

      expect(result.text).to.include('/docs/swagger.json');
    });

    it('should include configured page title', async () => {
      const result = await req().get('docs/').set('Accept', 'text/html').send();

      expect(result.text).to.include('Test API Docs');
    });

    it('should include configured CDN URLs', async () => {
      const result = await req().get('docs/').set('Accept', 'text/html').send();

      expect(result.text).to.include('cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css');
      expect(result.text).to.include('cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js');
    });
  });
});
