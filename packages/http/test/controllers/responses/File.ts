import { BaseController, BasePath, Get, FileResponse, ZipResponse, JsonFileResponse } from '../../../src';

@BasePath('files')
export class File extends BaseController {
  @Get()
  public file() {
    return new FileResponse({
      path: 'test.txt',
      filename: 'test.txt',
    });
  }

  @Get()
  public zippedFile() {
    return new ZipResponse({
      path: 'test.txt',
      filename: 'test.txt',
    });
  }

  @Get()
  public jsonFile() {
    return new JsonFileResponse(
      {
        foo: 'bar',
      },
      'data.txt',
    );
  }
}