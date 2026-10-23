import { BaseController, ContentDigest, Get, Head, Ok, Param, Put, RequestStream } from '@spinajs/http';

/** Shaped like @spinajs/upload's UploadController: abstract, outside the scanned dirs, documented only through a subclass. */
export abstract class ScopedUploadsBase extends BaseController {
  @Head(':upload')
  public async offset(@Param() upload: string) {
    return new Ok({ upload });
  }

  @Get(':upload')
  public async state(@Param() upload: string) {
    return new Ok({ upload });
  }

  @Put(':upload/parts/:part')
  public async putPart(@Param() upload: string, @Param() part: number, @RequestStream({ maxBytes: 1024 }) body: NodeJS.ReadableStream, @ContentDigest() digest: Map<string, Buffer>) {
    return new Ok({ upload, part, readable: !!body, algorithms: [...digest.keys()] });
  }
}
