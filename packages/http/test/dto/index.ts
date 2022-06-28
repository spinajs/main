import { ArgHydrator, Hydrator } from '../../src';
import { Schema } from '@spinajs/validation';

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

export interface SampleObject {
  id: number;
  name: string;
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
    return new SampleModelWithHydrator(input);
  }
}

export class ModelArgHydrator2 extends ArgHydrator {
  public async hydrate(input: any): Promise<any> {
    return new SampleModelWithHydrator2(input);
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
