import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall, Request } from '../interfaces';
import * as express from 'express';
import { Fields, Files, File, IncomingForm } from 'formidable';
import { Configuration } from '@spinajs/configuration';
import { isFunction } from 'lodash';
import { DI, Injectable, NewInstance } from '@spinajs/di';
import * as fs from 'fs';
import { parse } from 'csv';

interface FormData {
  Fields: Fields;
  Files: Files;
}

export type FormOptionsCallback = (conf: Configuration) => Promise<FormOptions>;

export interface FormOptions {
  encoding?: string;
  uploadDir?: string | FormOptionsCallback;
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

  protected async parseForm(callData: IRouteCall, param: IRouteParameter, req: Request) {
    if (callData && callData.Payload && callData.Payload.Form) {
      this.Data = callData.Payload.Form;
    }

    if (!this.Data) {
      await this.parse(req, param.Options);
    }
  }

  protected async parse(req: express.Request, options: FormOptions) {
    if (!this.Data) {
      let opts: any = options || { multiples: true };

      if (options && isFunction(options.uploadDir)) {
        opts = await options.uploadDir(DI.get(Configuration));
      }

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
    if (!this.Data) {
      await this.parseForm(callData, param, req);
    }

    // map from formidable to our object
    // of type IUploadedFile
    const formFiles = this.Data.Files[param.Name];

    if (Array.isArray(formFiles)) {
      return {
        CallData: {
          ...callData,
          Payload: {
            Form: this.Data,
          },
        },
        Args: formFiles.map((f: File) => {
          return {
            Size: f.size,
            Path: f.filepath,
            Name: f.originalFilename,
            Type: f.mimetype,
            LastModifiedDate: f.mtime,
            Hash: f.hash,
          };
        }),
      };
    } else {
      return {
        CallData: {
          ...callData,
          Payload: {
            Form: this.Data,
          },
        },
        Args: {
          Size: formFiles.size,
          Path: formFiles.filepath,
          Name: formFiles.originalFilename,
          Type: formFiles.mimetype,
          LastModifiedDate: formFiles.mtime,
          Hash: formFiles.hash,
        },
      };
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
    const content = await fs.promises.readFile(sourceFile, { encoding: param.Options.Encoding ?? 'utf-8', flag: 'r' });

    if (param.Options.DeleteFile) {
      fs.promises.unlink(sourceFile);
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
      fs.promises.unlink(sourceFile);
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
      fs.createReadStream(path)
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
