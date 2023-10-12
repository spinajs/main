import { IRouteArgsResult, RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, Request, IUploadOptions, IRoute } from '../interfaces.js';
import * as express from 'express';
import formidable, { Fields, Files, File, IncomingForm } from 'formidable';
import { Config, Configuration } from '@spinajs/configuration';
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { parse } from 'csv';
import { fs } from '@spinajs/fs';
import { basename } from 'path';
import { createReadStream, promises, unlink } from 'fs';
import _ from 'lodash';
import { Log, Logger } from '@spinajs/log-common';
import { InvalidOperation } from '@spinajs/exceptions';

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

const parseForm = (req: express.Request, options: any) => {
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
};

export abstract class FromFormBase extends RouteArgs {
  public Data: FormData;

  public async extract(callData: IRouteCall, routeParameter: IRouteParameter, req: Request, _res: express.Response, _route?: IRoute): Promise<IRouteArgsResult> {
    if (!this.Data) {
      if (callData && callData.Payload && callData.Payload.Form) {
        this.Data = callData.Payload.Form;
      } else {
        let opts: any = routeParameter.Options ?? { multiples: true };
        this.Data = await parseForm(req, opts);
      }
    }

    const result = {
      CallData: {
        ...callData,
        Payload: {
          Form: this.Data,
        },
      },
      Args: {},
    };

    return result;
  }
}

@Injectable()
@NewInstance()
export class FromFile extends FromFormBase {
  protected FileService: fs;

  @Logger('http')
  protected Log: Log;

  @Config('fs.defaultProvider')
  protected DefaultFsProviderName: string;

  public get SupportedType(): ParameterType {
    return ParameterType.FromFile;
  }

  constructor(data: any) {
    super();
    this.Data = data;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter<IUploadOptions>, req: Request, res: express.Response, route?: IRoute): Promise<any> {
    const self = this;

    const data = await super.extract(callData, param, req, res, route);

    if (!this.Data.Files[param.Name]) {
      throw new InvalidOperation(`Empty '${param.Name} parameter'`);
    }

    if (!this.FileService) {
      this.FileService = await DI.resolve('__file_provider__', [param.Options?.provider ?? this.DefaultFsProviderName]);
    }

    // map from formidable to our object
    // of type IUploadedFile
    const formFiles = _.isArray(this.Data.Files[param.Name]) ? (this.Data.Files[param.Name] as formidable.File[]) : ([this.Data.Files[param.Name]] as formidable.File[]);

    for (const f of formFiles) {
      await copy(f);
    }

    return Object.assign(data, {
      Args: param.RuntimeType.name === 'Array' ? formFiles.map(mf) : mf(formFiles[0]),
    });

    function mf(f: File) {
      return {
        Size: f.size,
        BaseName: basename(f.filepath),
        Provider: self.FileService,
        Name: f.originalFilename,
        Type: f.mimetype,
        LastModifiedDate: f.mtime,
        Hash: f.hash,
      };
    }

    async function copy(file: formidable.File) {
      const fName = basename(file.filepath);
      const stream = await self.FileService.writeStream(fName);

      self.Log.trace(`Copying incoming http file to ${file.filepath} to ${fName}, provider: ${self.FileService.Name}`);

      return new Promise<void>((resolve, reject) => {
        createReadStream(file.filepath)
          .pipe(stream)
          .on('finish', () => {
            self.Log.trace(`Finished copying incoming file ${file.filepath} to ${fName}, provider: ${self.FileService.Name}`);

            unlink(file.filepath, (err) => {
              if (err) {
                self.Log.warn(`Failed do delete incoming file ${file.filepath}, reason: ${err.message}`);
                reject(err);
              } else {
                self.Log.trace(`Incoming file ${file.filepath} deleted`);
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

    const data = this.Data.Fields[param.Name];

    return {
      CallData: {
        ...callData,
        Payload: {
          Form: this.Data,
        },
      },

      // by default form field is returned in array,
      // we assume that if length is 1 we want single param
      // when route param is not array
      Args: data.length === 1 && param.RuntimeType.name !== 'Array' ? data[0] : data,
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
    let result = null;

    if (!this.Data) {
      await this.parseForm(callData, param, req);
    }

    // todo
    // refactor to support arrays in object
    // and array of objects

    const data = Object.fromEntries(
      Object.entries(this.Data.Fields).map(([key, value]) => {
        return [key, value[0]];
      }),
    );

    const hydrator = this.getHydrator(param);

    if (hydrator) {
      result = await this.tryHydrateObject(data, param, hydrator);
    } else {
      result = data;
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
