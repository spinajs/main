import { BaseController, BasePath, ContentDigest, Ok, Param, Put, RequestStream } from '@spinajs/http';

/**
 * Raw-body uploads: the request body is the bytes themselves, not JSON or multipart.
 * @tags RawUploads
 */
@BasePath('raw-uploads')
export class RawUploadController extends BaseController {
  /**
   * Stores one part of an upload.
   * @param body Raw bytes of the part
   */
  @Put(':upload/parts/:part')
  public async putPart(@Param() upload: string, @Param() part: number, @RequestStream({ maxBytes: 1024 }) body: NodeJS.ReadableStream, @ContentDigest({ required: true }) digest: Map<string, Buffer>) {
    return new Ok({ upload, part, readable: !!body, algorithms: [...digest.keys()] });
  }

  /**
   * Replaces the whole content in one request.
   */
  @Put(':upload/content')
  public async putContent(@Param() upload: string, @RequestStream() body: NodeJS.ReadableStream, @ContentDigest() digest: Map<string, Buffer>) {
    return new Ok({ upload, readable: !!body, algorithms: [...digest.keys()] });
  }
}
