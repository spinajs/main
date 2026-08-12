import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

/**
 * Uploads and downloads - the two halves of the API surface that does not travel as JSON, and
 * the two the document used to get wrong in the same way: by describing the ARGUMENT the
 * action receives instead of the bytes on the wire.
 *
 * Neither is inferable from TypeScript. An uploaded file arrives as `IUploadedFile`, an
 * interface, which erases to `Object` and landed in the spec as a bare `{ type: 'object' }`;
 * a download returns a framework `Response` subclass, which no schema provider knows and so
 * fell back to `{ type: 'object' }` under application/json. Both compile, both look
 * plausible, and both make a generated client reject the operation at runtime - which is why
 * the frontend's kubb config still carries a standing instruction not to migrate multipart
 * operations to the generated client.
 *
 * `format: 'binary'` is the entire contract on the upload side: it is what makes a generator
 * type the field `Blob` / `File` and Swagger UI render a file picker.
 */
describe('Swagger file uploads and downloads', function () {
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

  /** The multipart body schema of a POST route under /files. */
  const uploadBody = (path: string) => {
    const body = spec?.paths?.[`/files/${path}`]?.post?.requestBody;
    expect(body, `no requestBody documented for /files/${path}`).to.exist;

    return body.content['multipart/form-data'].schema;
  };

  /** The 200 response content of a GET route under /files. */
  const downloadContent = (path: string) => {
    const response = spec?.paths?.[`/files/${path}`]?.get?.responses?.['200'];
    expect(response, `no 200 response documented for /files/${path}`).to.exist;

    return response.content;
  };

  describe('uploads', () => {
    it('documents a single @File() as a binary string, not as its erased interface', () => {
      expect(uploadBody('single').properties.file).to.deep.equal({ type: 'string', format: 'binary' });
    });

    it('carries @File({ required: true }) into the schema, where a client can see it', () => {
      // `requestBody.required` only says a body is expected; it is satisfied by a multipart
      // body with no file field at all, which the uploader then rejects with a 400.
      expect(uploadBody('single').required).to.deep.equal(['file']);
      expect(uploadBody('many')).to.not.have.property('required');
    });

    it('documents @Files() as an array of binaries', () => {
      expect(uploadBody('many').properties.files).to.deep.equal({
        type: 'array',
        items: { type: 'string', format: 'binary' },
      });
    });

    /**
     * Arity follows the runtime's own rule ( `FromForm.extract`: `RuntimeType.name === 'Array'
     * || Options.asArray` ), so an array-typed @File() argument is several files even without
     * the option - exactly as the extractor treats it.
     */
    it('documents an array-typed @File() argument as an array too', () => {
      expect(uploadBody('array-typed').properties.files).to.deep.equal({
        type: 'array',
        items: { type: 'string', format: 'binary' },
      });
    });

    /**
     * The action is handed parsed rows, but the REQUEST carries one file, and this document
     * describes the request. Reading the argument instead produced a spec demanding a JSON
     * object where the client has to send a `File` - the live `primespotImportLocalisations`
     * case, whose generated request schema is ten required strings.
     */
    it('documents @CsvFile() and @JsonFile() as one binary, not as the parsed content', () => {
      expect(uploadBody('csv').properties.rows).to.deep.equal({ type: 'string', format: 'binary' });
      expect(uploadBody('json-upload').properties.data).to.deep.equal({ type: 'string', format: 'binary' });
    });

    it('leaves ordinary form fields alone on a route that also takes a file', () => {
      const schema = uploadBody('with-fields');

      expect(schema.properties.file).to.deep.equal({ type: 'string', format: 'binary' });
      expect(schema.properties.title.type).to.equal('string');
      expect(schema.properties.title, 'a text field must not become a file').to.not.have.property('format');
    });

    it('does not turn a plain @Form() into a file', () => {
      expect(uploadBody('form-only').properties.form).to.not.have.property('format');
    });

    it('still sends every file route as multipart/form-data', () => {
      for (const path of ['single', 'many', 'csv', 'json-upload', 'with-fields']) {
        const content = spec.paths[`/files/${path}`].post.requestBody.content;
        expect(Object.keys(content), path).to.deep.equal(['multipart/form-data']);
      }
    });
  });

  describe('downloads', () => {
    /**
     * A `FileResponse` writes bytes and a `Content-Disposition` header, never a serialised
     * instance of itself. Its own mime type is a constructor option that is usually left unset
     * so `res.sendFile` can derive it from the file, so the document says only "binary".
     */
    it('documents a FileResponse as a binary body, not as JSON', () => {
      const content = downloadContent('download');

      expect(Object.keys(content)).to.deep.equal(['application/octet-stream']);
      expect(content['application/octet-stream'].schema).to.deep.equal({ type: 'string', format: 'binary' });
    });

    it('does not depend on the route declaring a mime type', () => {
      expect(Object.keys(downloadContent('download-untyped'))).to.deep.equal(['application/octet-stream']);
    });

    it('gives a ZipResponse the media type its constructor pins', () => {
      const content = downloadContent('archive');

      expect(Object.keys(content)).to.deep.equal(['application/zip']);
      expect(content['application/zip'].schema).to.deep.equal({ type: 'string', format: 'binary' });
    });

    /** JSON, but sent as an attachment - so a binary body under the JSON media type. */
    it('documents a JsonFileResponse as a binary body under application/json', () => {
      expect(downloadContent('export')['application/json'].schema).to.deep.equal({ type: 'string', format: 'binary' });
    });

    it('leaves an ordinary JSON route completely alone', () => {
      const schema = downloadContent('plain')['application/json'].schema;

      expect(schema.type).to.equal('object');
      expect(schema.properties.ok.type).to.equal('boolean');
      expect(schema).to.not.have.property('format');
    });
  });
});
