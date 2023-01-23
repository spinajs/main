import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, Request } from '../interfaces.js';
import * as express from 'express';
import { Fields, Files, File, IncomingForm } from 'formidable';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { parse } from 'csv';
import { fs } from '@spinajs/fs';
import { basename } from 'path';
import { createReadStream, promises, unlink } from 'fs';

interface FormData {
  Fields: Fields;
  Files: Files;
}

export type FormOptionsCallback = (conf: Configuration) => Promise<FormOptions>;

export interface FormOptions {
  encoding?: string;

  /**
   * Wchitch service is handling incoming file storage
   * fs file provider, defaults to default provider set in configuration
   * can be local, remote, aws s3, ftp, etc
   */
  fileProvider?: string;
  keepExtensions?: boolean;
  maxFileSize?: number;
  maxFieldsSize?: number;
  maxFields?: number;
  hash?: string | boolean;
  multiples?: boolean;
  type?: string;
}

export abstract class FromFormBase extends RouteArgs {
  public Data: FormData;

  protected FileService: fs;

  protected async parseForm(callData: IRouteCall, param: IRouteParameter, req: Request) {
    if (callData && callData.Payload && callData.Payload.Form) {
      this.Data = callData.Payload.Form;
    }

    if (!this.Data) {
      await this.parse(req, param.Options);
    }
  }

  protected async parse(req: express.Request, options: FormOptions) {
    this.FileService = await DI.resolve('__file_provider__', [options?.fileProvider]);

    if (!this.Data) {
      let opts: any = options || { multiples: true };
      this.Data = await this._parse(req, opts);
    }
  }

  private _parse(req: express.Request, options: any) {
    const form = new IncomingForm(options);
    return new Promise<FormData>((res, rej) => {
      form.parse(req, (err: any, fields: Fields, files: Files) => {
        if (err) {
          rej(err);
          return;
        }

        res({ Fields: fields, Files: files });
      });
    });
  }
}

@Injectable()
@NewInstance()
export class FromFile extends FromFormBase {
  public get SupportedType(): ParameterType {
    return ParameterType.FromFile;
  }

  constructor(data: any) {
    super();
    this.Data = data;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request): Promise<any> {
    const self = this;

    if (!this.Data) {
      await this.parseForm(callData, param, req);
    }

    // map from formidable to our object
    // of type IUploadedFile
    const formFiles = this.Data.Files[param.Name];
    const data = {
      CallData: {
        ...callData,
        Payload: {
          Form: this.Data,
        },
      },
    };

    if (Array.isArray(formFiles)) {
      for (const f of formFiles) {
        await copy(f.filepath);

        return Object.assign(data, {
          Args: formFiles.map(mf),
        });
      }
    } else {
      await copy(formFiles.filepath);
      return Object.assign(data, {
        Args: mf(formFiles),
      });
    }

    function mf(f: File) {
      return {
        Size: f.size,
        BaseName: basename(f.filepath),
        Provider: {
          Name: self.FileService.Name,
          Service: self.FileService.constructor.name,
        },
        Name: f.originalFilename,
        Type: f.mimetype,
        LastModifiedDate: f.mtime,
        Hash: f.hash,
      };
    }

    async function copy(file: string) {
      const stream = await self.FileService.writeStream(basename(file));

      return new Promise<void>((resolve, reject) => {
        createReadStream(file)
          .pipe(stream)
          .on('finish', () => {
            unlink(file, (err) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          })
          .on('error', (err: any) => {
            reject(err);
          });
      });
    }
  }
}

@Injectable()
@NewInstance()
export class JsonFileRouteArgs extends FromFile {
  public get SupportedType(): ParameterType {
    return ParameterType.FromJSONFile;
  }

  constructor(data: any) {
    super(data);
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request) {
    if (!this.Data) {
      await this.parseForm(callData, param, req);
    }

    const sourceFile = (this.Data.Files[param.Name] as File).filepath;
    const content = await promises.readFile(sourceFile, { encoding: param.Options.Encoding ?? 'utf-8', flag: 'r' });

    if (param.Options.DeleteFile) {
      await promises.unlink(sourceFile);
    }

    return {
      CallData: {
        ...callData,
        Payload: {
          Form: this.Data,
        },
      },
      Args: JSON.parse(content.toString()),
    };
  }
}

@Injectable()
@NewInstance()
export class CsvFileRouteArgs extends FromFile {
  public get SupportedType(): ParameterType {
    return ParameterType.FromCSV;
  }

  constructor(data: any) {
    super(data);
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request) {
    if (!this.Data) {
      await this.parseForm(callData, param, req);
    }

    const sourceFile = (this.Data.Files[param.Name] as File).filepath;
    if (param.Options.DeleteFile) {
      await promises.unlink(sourceFile);
    }

    const data = await this.parseCvs(sourceFile);

    return {
      CallData: {
        ...callData,
        Payload: {
          Form: this.Data,
        },
      },
      Args: data,
    };
  }

  protected async parseCvs(path: string) {
    const data: any[] = [];

    return new Promise((res, rej) => {
      createReadStream(path)
        .pipe(parse())
        .on('error', (err: any) => rej(err))
        .on('data', (row: any) => data.push(row))
        .on('end', () => res(data));
    });
  }
}

@Injectable()
@NewInstance()
export class FromFormField extends FromFormBase {
  public get SupportedType(): ParameterType {
    return ParameterType.FormField;
  }

  constructor(data: any) {
    super();
    this.Data = data;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request) {
    if (!this.Data) {
      await this.parseForm(callData, param, req);
    }

    return {
      CallData: {
        ...callData,
        Payload: {
          Form: this.Data,
        },
      },
      Args: this.Data.Fields[param.Name],
    };
  }
}
@Injectable()
@NewInstance()
export class FromForm extends FromFormBase {
  public get SupportedType(): ParameterType {
    return ParameterType.FromForm;
  }

  constructor(data: any) {
    super();
    this.Data = data;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request) {
    if (!this.Data) {
      await this.parseForm(callData, param, req);
    }

    let result = this.Data.Fields;
    const [hydrated, hValue] = await this.tryHydrateObject(this.Data.Fields, param);
    if (hydrated) {
      result = hValue;
    }

    return {
      CallData: {
        ...callData,
        Payload: {
          Form: this.Data,
        },
      },
      Args: result,
    };
  }
}
