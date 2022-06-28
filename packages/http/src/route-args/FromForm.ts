import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces';
import * as express from 'express';
import { Fields, Files, File, IncomingForm } from 'formidable';
import { Configuration } from '@spinajs/configuration';
import { isFunction } from 'lodash';
import { DI, Injectable } from '@spinajs/di';
import { parse } from '@fast-csv/parse';
import * as fs from 'fs';

interface FormData {
  Fields: Fields;
  Files: Files;
}

export type FormOptionsCallback = (conf: Configuration) => Promise<FormOptions>;

export interface FormOptions {
  encoding?: string;
  uploadDir?: string;
  keepExtensions?: boolean;
  maxFileSize?: number;
  maxFieldsSize?: number;
  maxFields?: number;
  hash?: string | boolean;
  multiples?: boolean;
  type?: string;
}

export abstract class FromFormBase extends RouteArgs {
  protected Data: FormData;

  protected async parseForm(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    if (callData && callData.Payload && callData.Payload.Form) {
      this.Data = callData.Payload.Form;
    }

    if (!this.Data) {
      await this.parse(req, param.Options);
    }
  }

  protected async parse(req: express.Request, options: FormOptions | FormOptionsCallback) {
    if (!this.Data) {
      let opts: any = options;

      if (options && isFunction(options)) {
        opts = await options(DI.get(Configuration));
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

@Injectable(RouteArgs)
export class FromFile extends FromFormBase {
  public get SupportedType(): ParameterType {
    return ParameterType.FromFile;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request): Promise<any> {
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
            Path: f.path,
            Name: f.name,
            Type: f.type,
            LastModifiedDate: f.lastModifiedDate,
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
          Path: formFiles.path,
          Name: formFiles.name,
          Type: formFiles.type,
          LastModifiedDate: formFiles.lastModifiedDate,
          Hash: formFiles.hash,
        },
      };
    }
  }
}

@Injectable(RouteArgs)
export class JsonFileRouteArgs extends FromFile {
  public get SupportedType(): ParameterType {
    return ParameterType.FromJSONFile;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    if (!this.Data) {
      await this.parseForm(callData, param, req);
    }

    const sourceFile = (this.Data.Files[param.Name] as File).path;
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

@Injectable(RouteArgs)
export class CsvFileRouteArgs extends FromFile {
  public get SupportedType(): ParameterType {
    return ParameterType.FromCSV;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    if (!this.Data) {
      await this.parseForm(callData, param, req);
    }

    const sourceFile = (this.Data.Files[param.Name] as File).path;
    if (param.Options.DeleteFile) {
      fs.promises.unlink(sourceFile);
    }

    const data = await this.parseCvs(sourceFile, param.Options);

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

  protected async parseCvs(path: string, options: any) {
    const data: any[] = [];
    return new Promise((res, rej) => {
      fs.createReadStream(path)
        .pipe(parse(options))
        .on('error', (err: any) => rej(err))
        .on('data', (row: any) => data.push(row))
        .on('end', () => res(data));
    });
  }
}

@Injectable(RouteArgs)
export class FromFormField extends FromFormBase {
  public get SupportedType(): ParameterType {
    return ParameterType.FromForm;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
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
@Injectable(RouteArgs)
export class FromForm extends FromFormBase {
  public get SupportedType(): ParameterType {
    return ParameterType.FromForm;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
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
