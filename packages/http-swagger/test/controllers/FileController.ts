import { BaseController, BasePath, CsvFile, File, Files, FileResponse, Form, FormField, Get, IUploadedFile, JsonFile, JsonFileResponse, Ok, Post, ZipResponse } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

/**
 * The DTO half of a form+file route. `required` matters to the test: once the form schema is
 * lifted onto the body, its required fields have to travel with it.
 */
@Schema({
  type: 'object',
  $id: 'test.FormPayloadDto',
  required: ['state'],
  properties: {
    comment: { type: 'string', maxLength: 128 },
    state: { type: 'string', enum: ['open', 'closed'] },
  },
})
export class FormPayloadDto {
  public comment?: string;

  public state: 'open' | 'closed';
}

/**
 * Uploads and downloads, the two halves of the API surface that does not travel as JSON.
 *
 * An uploaded file is `type: string, format: binary` in OpenAPI, and a download is a binary
 * response body - neither is inferable from the TypeScript type, which is an interface
 * (`IUploadedFile`, erased to `Object`) on the way in and a framework `Response` subclass on
 * the way out.
 *
 * @tags FileTests
 */
@BasePath('files')
export class FileController extends BaseController {
  /**
   * Single uploaded file.
   */
  @Post('single')
  public async single(@File({ required: true }) file: IUploadedFile) {
    return new Ok({ name: file?.Name });
  }

  /**
   * Several files under one field, via @Files().
   */
  @Post('many')
  public async many(@Files() files: IUploadedFile[]) {
    return new Ok({ count: files?.length });
  }

  /**
   * An array-typed @File() argument, which the runtime also treats as multiple
   * (FromForm: `RuntimeType.name === 'Array' || Options.asArray`).
   */
  @Post('array-typed')
  public async arrayTyped(@File() files: IUploadedFile[]) {
    return new Ok({ count: files?.length });
  }

  /**
   * An upload the action receives already PARSED - the request still carries a file.
   */
  @Post('csv')
  public async csv(@CsvFile() rows: unknown[]) {
    return new Ok({ count: rows?.length });
  }

  /**
   * Same, for a JSON upload.
   */
  @Post('json-upload')
  public async jsonUpload(@JsonFile() data: unknown) {
    return new Ok({ data });
  }

  /**
   * A file alongside ordinary form fields.
   */
  @Post('with-fields')
  public async withFields(@File() file: IUploadedFile, @FormField() title: string) {
    return new Ok({ title, name: file?.Name });
  }

  /**
   * A plain multipart form with no file at all - must NOT be documented as binary.
   */
  @Post('form-only')
  public async formOnly(@Form() form: unknown) {
    return new Ok(form);
  }

  /**
   * A `@Form()` DTO next to a file. `FromForm` hydrates the DTO from the form's ROOT fields, so
   * `comment` / `state` travel as top-level parts and the parameter's name never appears on the
   * wire - the document has to say the same.
   */
  @Post('form-with-file')
  public async formWithFile(@Form() body: FormPayloadDto, @File() attachment: IUploadedFile) {
    return new Ok({ body, name: attachment?.Name });
  }

  /**
   * Downloads a file.
   */
  @Get('download')
  public async download(): Promise<FileResponse> {
    return new FileResponse({ path: '/tmp/report.pdf', filename: 'report.pdf', mimeType: 'application/pdf' });
  }

  /**
   * Downloads a file with no declared mime type.
   */
  @Get('download-untyped')
  public async downloadUntyped(): Promise<FileResponse> {
    return new FileResponse({ path: '/tmp/report.bin', filename: 'report.bin' });
  }

  /**
   * Downloads a zip archive.
   */
  @Get('archive')
  public async archive(): Promise<ZipResponse> {
    return new ZipResponse({ path: '/tmp/bundle', filename: 'bundle.zip' });
  }

  /**
   * Sends JSON as a download rather than as a body.
   */
  @Get('export')
  public async exportJson(): Promise<JsonFileResponse> {
    return new JsonFileResponse({ a: 1 }, 'export.json');
  }

  /**
   * An ordinary JSON route, to prove the file handling does not leak into it.
   */
  @Get('plain')
  public async plain(): Promise<Ok<{ ok: boolean }>> {
    return new Ok({ ok: true });
  }
}
