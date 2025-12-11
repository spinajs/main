import { IRouteArgsResult, RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, Request, IRoute, IUploadOptions, FormFileUploader, IUploadedFile, FileUploadMiddleware, UploadFileMiddlewareDescriptor } from '../interfaces.js';
import * as express from 'express';
import formidable, { Fields, Files, IncomingForm } from 'formidable';
import { Config, Configuration } from '@spinajs/configuration';
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { parse } from 'csv';
import { fs, fsNative } from '@spinajs/fs';
import { createReadStream, promises } from 'fs';
import _ from 'lodash';
import { Log, Logger } from '@spinajs/log-common';
import { basename } from 'node:path';
import { toArray } from '@spinajs/util';
import { ValidationFailed } from '@spinajs/validation';
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

  public async extract(callData: IRouteCall, _args: unknown[], routeParameter: IRouteParameter, req: Request, _res: express.Response, _route?: IRoute, uploadFs?: fs): Promise<IRouteArgsResult> {
    if (!this.FormData) {
      const options = {
        ...routeParameter.Options,
        uploadDir: uploadFs && uploadFs instanceof fsNative ? uploadFs.Options.basePath : undefined,
      };
      this.FormData = callData?.Payload?.Form ?? (await parseForm(req, options));
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

  public Priority?: number = 9999;

  @Logger('http')
  protected Log: Log;

  @Config('fs.defaultProvider')
  protected DefaultFsProviderName: string;

  @Config('http.upload.middlewares', {
    defaultValue: [{ service: 'FileInfoMiddleware' }]
  })
  protected DefaultFileMiddlewares: UploadFileMiddlewareDescriptor[];

  public get SupportedType(): ParameterType {
    return ParameterType.FromFile;
  }

  constructor(public FormData: FormData) {
    super();
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter<IUploadOptions>, req: Request, res: express.Response, route?: IRoute): Promise<any> {
    // copy to provided fs or default temp fs
    // delete intermediate files ( from express ) regardless of copy result

    const uploadOptions = param.Options ?? {};
    const fsName = uploadOptions.fs ? uploadOptions.fs : '__file_upload_default_provider__';
    const uploadFs = DI.resolve<fs>('__file_provider__', [fsName]);

    // extract form data if not processed already
    // and prepare result object
    const result = await super.extract(callData, _args, param, req, res, route, uploadFs);

    // get incoming files
    const { Files } = this.FormData;
    const files = toArray(Files[param.Name]);

    if (uploadOptions.required && files.length === 0) {
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
        Provider: uploadFs,
        OriginalFile: f,
      };

      return uploadedFile;
    });

    let uFiles: IUploadedFile<any>[] = uplFiles;

    const middlewareDescriptors = [
      ...(this.DefaultFileMiddlewares ?? []),
      ...(uploadOptions.middlewares ?? []),
    ];

    const middlewares = middlewareDescriptors.map((m) => {
      if (typeof m === 'string' || typeof m === 'function') {
        return DI.resolve<FileUploadMiddleware>(m as any);
      }

      const { service, options } = m as UploadFileMiddlewareDescriptor & { service: any; options?: any };
      return DI.resolve<FileUploadMiddleware>(service, [options]);
    });

    for (const m of middlewares) {
      for (const f of uplFiles) {
        this.Log.trace(`Executing file middleware ${m.constructor.name} for file ${f.Name}`);
        const result = await m.beforeUpload(f, uploadOptions);
        // merge transform result
        Object.assign(f, result);
      }
    }

    if (uploadOptions.uploader) {
      const type = (uploadOptions.uploader as any).service ?? uploadOptions.uploader;
      const options = (uploadOptions.uploader as any).options ?? {};

      const fu = DI.resolve<FormFileUploader>(type, [options]);
      const pResults = await Promise.allSettled(uplFiles.map((f) => fu.upload(f)));
      uFiles = pResults.filter((r) => r.status === 'fulfilled').map((r: PromiseFulfilledResult<IUploadedFile>) => r.value);
    }

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

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: Request, res: express.Response, route?: IRoute) {
    const data = await super.extract(callData, _args, param, req, res, route);
    const files = this.FormData.Files[param.Name];
    const file = files ? (Array.isArray(files) ? files[0] : files) : null;

    if (!file) {
      throw new BadRequest('Missing JSON file');
    }

    const sourceFile = file.filepath;
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

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: Request, res: express.Response, route?: IRoute) {
    const data = await super.extract(callData, _args, param, req, res, route);

    const files = this.FormData.Files[param.Name];
    const file = files ? (Array.isArray(files) ? files[0] : files) : null;

    if (!file) {
      throw new BadRequest('Missing csv file');
    }

    const sourceFile = file.filepath;
    const cvsData = (await this.parseCvs(param, sourceFile)) as [];

    if (param.Options.DeleteFile) {
      await promises.unlink(sourceFile);
    }

    const args = await Promise.all(cvsData.map((x) => this.tryHydrateParam(x, param, route)));

    return {
      ...data,
      Args: args,
    };
  }

  protected async parseCvs(param: IRouteParameter, path: string) {
    const data: any[] = [];

    return new Promise((res, rej) => {
      createReadStream(path)
        .pipe(parse(param.Options ?? {}))
        .on('error', (err: any) => rej(new BadRequest('Cannot read data from cvs', err)))
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

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: Request, res: express.Response, route?: IRoute) {
    const data = await super.extract(callData, _args, param, req, res, route);
    const field = this.FormData.Fields[param.Name];

    if (!field) {
      throw new BadRequest(`Form field ${param.Name} is required`);
    }

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

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: Request, res: express.Response, route?: IRoute) {
    const data = await super.extract(callData, _args, param, req, res, route);
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
