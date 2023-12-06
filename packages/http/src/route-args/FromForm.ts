import { IRouteArgsResult, RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, Request, IRoute, IUploadOptions } from '../interfaces.js';
import * as express from 'express';
import { Fields, Files, File, IncomingForm } from 'formidable';
import { Config, Configuration } from '@spinajs/configuration';
import { Injectable, NewInstance } from '@spinajs/di';
import { parse } from 'csv';
import { fs } from '@spinajs/fs';
import { createReadStream, promises } from 'fs';
import _ from 'lodash';
import { Log, Logger } from '@spinajs/log-common';
import { pipe } from "effect";
import { flatMap , tryPromise, map, fromNullable, zip, either, partition } from "effect/Effect";
import { default as FP} from "@spinajs/util-fp";
import Util from "@spinajs/util";
import { basename } from 'node:path';
 

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
  public FormData: FormData;

  public async extract(callData: IRouteCall, routeParameter: IRouteParameter, req: Request, _res: express.Response, _route?: IRoute): Promise<IRouteArgsResult> {
    if (!this.FormData) {
      this.FormData = callData?.Payload?.Form ?? (await parseForm(req, routeParameter.Options ?? { multiples: true }));
    }

    const result = {
      CallData: {
        ...callData,
        Payload: {
          Form: this.FormData,
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

  constructor(public FormData: FormData) {
    super();
  }

  public async extract(callData: IRouteCall, param: IRouteParameter<IUploadOptions>, req: Request, res: express.Response, route?: IRoute): Promise<any> {

    // extract form data if not processed already
    const result = await super.extract(callData, param, req, res, route);

    // get incoming files
    const { Files } = this.FormData;
  
    // combine files from form data & file provider
    // for further processing
    const params = zip(

      // convert files to array for simplicity
      map(fromNullable(Files[param.Name]),Util.Array.toArray), 

      // get provider from param options or default
      FP.Fs.getFsProvider(param.Options.provider ?? this.DefaultFsProviderName)
    );

    params.pipe(flatMap(([files, fs]) => partition(files, (f) =>{ 
      
    })))

    const copyToFs = ( file: string) => either(pipe(
      fs,
      flatMap((fs) => tryPromise(() => fs.writeStream(basename(file)))),
      flatMap((stream) => tryPromise<void>(() =>{ 
        return new Promise((resolve,reject) => { 
          createReadStream(file).pipe(stream).on('finish', resolve).on('error', reject);
        })
      })),
      Effect.match({
        onFailure: () => FP.Fs.del(file),
        onSuccess: () => FP.Fs.del(file)
      })
    )) 

     


    const d = (file: string) => fs.pipe( Effect.map( (fs) => Effect.tryPromise(async () => {
    const del = (file : string) => fs.pipe(Effect.tap((fs) => Effect.tryPromise(() => fs.unlink(basename(file)))), Effect.tap((fs) => FP.Logger.trace('http', `Deletet file ${file} from ${fs.Name}`)));
    const delTemp  = ( file : string) => FP.Fs.del(file).pipe(() => FP.Logger.trace('http', `Deleted temporary file ${file}`))
    const delAllFs = (f: string[]) => Effect.validateAll(f, (f) => del(f), { concurrency: 'unbounded' });
    const delAll = (f: string[]) => Effect.validateAll(f, (f) => delTemp(f), { concurrency: 'unbounded' });
    const copyAll = (f: string[]) => Effect.orElse(Effect.partition(f, (f) =>
                    Effect.tapBoth(copyToFs(f), {
                        onFailure: (err : Error) => FP.Logger.error(`http`, err, `Error copying incoming file ${f}`),
                        onSuccess: () => FP.Logger.success(`http`, `Success receiving incoming file ${f}`)
                    }), {
                    concurrency: "unbounded"
                }), () => delAll(f));

  

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
}

@Injectable()
@NewInstance()
export class JsonFileRouteArgs extends FromFile {
  public get SupportedType(): ParameterType {
    return ParameterType.FromJSONFile;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request, res: express.Response, route?: IRoute) {
    const data = await super.extract(callData, param, req, res, route);
    const sourceFile = (this.FormData.Files[param.Name] as File).filepath;
    const content = await promises.readFile(sourceFile, { encoding: param.Options.Encoding ?? 'utf-8', flag: 'r' });

    if (param.Options.DeleteFile) {
      await promises.unlink(sourceFile);
    }

    return {
      ...data,
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

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request, res: express.Response, route?: IRoute) {
    const data = await super.extract(callData, param, req, res, route);

    const sourceFile = (this.FormData.Files[param.Name] as File).filepath;
    if (param.Options.DeleteFile) {
      await promises.unlink(sourceFile);
    }

    const cvsData = await this.parseCvs(sourceFile);
    return {
      ...data,
      Args: cvsData,
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

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request, res: express.Response, route?: IRoute) {
    const data = await super.extract(callData, param, req, res, route);
    const field = this.FormData.Fields[param.Name];

    return {
      ...data,

      // by default form field is returned in array,
      // we assume that if length is 1 we want single param
      // when route param is not array
      Args: field.length === 1 && param.RuntimeType.name !== 'Array' ? field[0] : data,
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
    this.FormData = data;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request, res: express.Response, route?: IRoute) {
    const data = await super.extract(callData, param, req, res, route);
    let result = null;

    // todo
    // refactor to support arrays in object
    // and array of objects
    const fData = Object.fromEntries(
      Object.entries(this.FormData.Fields).map(([key, value]) => {
        return [key, value[0]];
      }),
    );

    const hydrator = this.getHydrator(param);

    if (hydrator) {
      result = await this.tryHydrateObject(fData, param, hydrator);
    } else {
      result = data;
    }

    return {
      ...data,
      Args: result,
    };
  }
}
