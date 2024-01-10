import { IRouteArgsResult, RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, Request, IRoute, IUploadOptions, FormFileUploader, IUploadedFile, FileTransformer } from '../interfaces.js';
import * as express from 'express';
import formidable, { Fields, Files, File, IncomingForm } from 'formidable';
import { Config, Configuration } from '@spinajs/configuration';
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { parse } from 'csv';
import { fs } from '@spinajs/fs';
import { createReadStream, promises } from 'fs';
import _ from 'lodash';
import { Log, Logger } from '@spinajs/log-common';
import { basename } from 'node:path';
import { toArray } from '@spinajs/util';
import { ValidationFailed } from '@spinajs/validation';
import { ImmediateFileUploader } from '../uploaders/ImmediateFileUploader.js';
import { EntityTooLargeException } from '../exceptions.js';
import { BadRequest, Exception } from '@spinajs/exceptions';
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
        switch (err.code) {
          case 1009:
            rej(new EntityTooLargeException(err.message, err));
            break;
          default:
            rej(new Exception(err.message, err));
        }
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
    // copy to provided fs or default temp fs
    // delete intermediate files ( from express ) regardless of copy result

    // extract form data if not processed already
    // and prepare result object
    const result = await super.extract(callData, param, req, res, route);

    // get incoming files
    const { Files } = this.FormData;

    // get fs provider for storing files
    // hack - fix DI resolve type
    const fu = DI.resolve<FormFileUploader>((param.Options?.uploader as any) ?? ImmediateFileUploader, [param.Options?.uploaderFs ?? this.DefaultFsProviderName]);
    const formidableFs = DI.resolve<fs>('__file_provider__', ['__formidable_default_file_provider__']);


    const _rm = async (file: formidable.File) => {
      try {
        await  formidableFs.rm(file.newFilename);
        this.Log.trace(`Deleted temporary incoming file ${file.originalFilename}`);
      } catch (err) {
        this.Log.error(err, `Error deleting temporary incoming file ${file.originalFilename}`);
      }
    };

    const files = toArray(Files[param.Name]);

    if (param.Options?.required && files.length === 0) {
      throw new ValidationFailed(`File ${param.Name} is required`, [
        {
          propertyName: param.Name,
          message: 'Missing file',
          keyword: 'required',
          params: {},
          schemaPath: '#/required',
          instancePath: 'FormData',
        },
      ]);
    }

    const uplFiles = files.map((f: formidable.File) => {
      const uploadedFile: IUploadedFile = {
        Size: f.size,
        BaseName: basename(f.filepath),
        Name: f.originalFilename,
        Type: f.mimetype,
        LastModifiedDate: f.mtime,
        Hash: f.hash,
        Provider: formidableFs,
        OriginalFile: f,
      };

      return uploadedFile;
    });

    for (const t of param.Options?.transformers ?? []) {
      const c = Array.isArray(t) ? t[0] : t;
      const o = Array.isArray(t) ? [t[1]] : [];
      const transformer = DI.resolve<FileTransformer>(c, o);

      for (const f of uplFiles) {
        const result = await transformer.transform(f);

        // merge transform result
        Object.assign(f, result);
      }
    }

    const pResults = await Promise.allSettled(uplFiles.map((f) => fu.upload(f)));

    const uFiles = pResults.filter((r) => r.status === 'fulfilled').map((r: PromiseFulfilledResult<IUploadedFile>) => r.value);

    await Promise.allSettled(files.map(f => _rm(f)));

    return Object.assign(result, {
      Args: param.RuntimeType.name === 'Array' ? uFiles : uFiles[0],
    });
  }
}

@Injectable()
@NewInstance()
export class FromJsonFile extends FromFile {
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
export class FromCSV extends FromFormBase {
  public get SupportedType(): ParameterType {
    return ParameterType.FromCSV;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request, res: express.Response, route?: IRoute) {
    const data = await super.extract(callData, param, req, res, route);

    const files = this.FormData.Files[param.Name];
    const file = files ? Array.isArray(files) ? files[0]  : files : null;

    if(!file){
      throw new BadRequest('Missing csv file');
    }

    const sourceFile = file.filepath;
    const cvsData = await this.parseCvs(param, sourceFile);

    if (param.Options.DeleteFile) {
      await promises.unlink(sourceFile);
    }

    return {
      ...data,
      Args: cvsData,
    };
  }

  protected async parseCvs(param: IRouteParameter,path: string) {
    const data: any[] = [];

    return new Promise((res, rej) => {
      createReadStream(path)
        .pipe(parse(param.Options))
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

    result = await this.tryHydrateParam(fData, param, route);

    return {
      ...data,
      Args: result,
    };
  }
}
