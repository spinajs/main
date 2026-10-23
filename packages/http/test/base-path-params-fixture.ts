import type { Readable } from 'node:stream';

import { BaseController, ContentDigest, Get, Head, Ok, Param, Put, Req, RequestStream } from '../src/index.js';
import type { Request } from '../src/index.js';

async function byteCount(body: Readable): Promise<number> {
  let bytes = 0;
  for await (const chunk of body) bytes += (chunk as Buffer).length;
  return bytes;
}

/** Shaped like @spinajs/upload's UploadController: abstract, in a file no controllers dir lists, mounted through a subclass. */
export abstract class ScopedUploadsBase extends BaseController {
  @Head(':upload')
  public async offset(@Param() upload: string, @Req() req: Request) {
    return new Ok(null, {
      Headers: [
        { Name: 'x-route', Value: 'head' },
        { Name: 'x-scope', Value: `${String(req.params.project)}/${upload}` },
      ],
    });
  }

  @Get(':upload')
  public async state(@Param() upload: string, @Req() req: Request) {
    return new Ok({ route: 'get', project: req.params.project, upload }, { Headers: [{ Name: 'x-route', Value: 'get' }] });
  }

  @Put(':upload/parts/:part')
  public async putPart(@Param() upload: string, @Param() part: number, @RequestStream({ maxBytes: 64 }) body: NodeJS.ReadableStream, @ContentDigest() digest: Map<string, Buffer>, @Req() req: Request) {
    return new Ok({ project: req.params.project, upload, part, bytes: await byteCount(body as Readable), algorithms: [...digest.keys()] });
  }
}

/** The same HEAD and GET routes with GET declared first. */
export abstract class GetFirstBase extends BaseController {
  @Get(':upload')
  public async state() {
    return new Ok(null, { Headers: [{ Name: 'x-route', Value: 'get' }] });
  }

  @Head(':upload')
  public async offset() {
    return new Ok(null, { Headers: [{ Name: 'x-route', Value: 'head' }] });
  }
}
