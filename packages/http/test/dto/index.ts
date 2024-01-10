import { ArgHydrator, Hydrator } from '../../src/index.js';
import { Schema } from '@spinajs/validation';
import _ from 'lodash';

export const SampleObjectSchema = {
  type: 'object',
  properties: {
    id: { type: 'number' },
    name: { type: 'string' },
  },
  required: ['id', 'name'],
};

export const SampleModelSchema = {
  type: 'object',
  properties: {
    id: { type: 'number' },
    name: { type: 'string' },
    args: { type: 'array', items: { type: 'number' } },
  },
  required: ['id', 'name', 'args'],
};

export const CvsSampleObjectWithSchemaSchema = {
  type: 'object',
  properties: {
    Username: { type: 'string' },
    Identifier: { type: 'number' },
    FirstName: { type: 'string' },
    LastName: { type: 'string' },
  },
  required: ['Username', 'Identifier', 'FirstName', 'LastName'],
};

export interface CvsSampleObject {
  Username: string;
  Identifier: number;
  FirstName: string;
  LastName: string;
}

@Schema(CvsSampleObjectWithSchemaSchema)
export class CvsSampleObjectWithSchema {
  Username: string;
  Identifier: number;
  FirstName: string;
  LastName: string;
}

export interface SampleObject {
  id: number;
  name: string;
}

@Schema(SampleObjectSchema)
export class SampleObjectWithSchema {
  id: number;
  name: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

export class SampleModel {
  public id: number;
  public name: string;
  public args: number[];

  constructor(data: any) {
    Object.assign(this, data);
  }
}

@Schema(SampleModelSchema)
export class SampleModelWithSchema {
  public id: number;
  public name: string;
  public args: number[];

  constructor(data: any) {
    Object.assign(this, data);
  }
}

export class ModelArgHydrator extends ArgHydrator {
  public async hydrate(input: any): Promise<any> {
    if (Array.isArray(input)) {
      return input.map((x) => new SampleModelWithHydrator(x));
    }
    return new SampleModelWithHydrator(input);
  }
}

export class ModelArgHydrator2 extends ArgHydrator {
  public async hydrate(input: any): Promise<any> {
    return new SampleModelWithHydrator2(input);
  }
}

export class ModelArgHydrator3 extends ArgHydrator {
  public async hydrate(input: any): Promise<any> {
    return new SampleModelWithHydrator3({
      ...input,
      args: parseInt(input.args),
    });
  }
}

@Hydrator(ModelArgHydrator)
export class SampleModelWithHydrator {
  public id: number;
  public name: string;
  public args: number[];

  constructor(data: any) {
    Object.assign(this, data);
  }
}

@Hydrator(ModelArgHydrator2)
export class SampleModelWithHydrator2 {
  public id: number;

  constructor(data: string) {
    this.id = Number(data);
  }
}

@Hydrator(ModelArgHydrator3)
export class SampleModelWithHydrator3 {
  public id: number;
  public name: string;
  public args: number[];

  constructor(data: any) {
    Object.assign(this, data);
  }
}
