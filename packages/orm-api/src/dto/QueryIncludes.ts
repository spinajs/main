import { Hydrator } from '@spinajs/http';
import { QueryIncludesHydrator } from '../hydrators/QueryIncludesHydrator.js';
import QueryIncludesSchema from '../schemas/QueryIncludes.schema.js';
import { Schema } from '@spinajs/validation';

@Hydrator(QueryIncludesHydrator)
@Schema(QueryIncludesSchema)
export class QueryIncludes {
  [key: string]: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}
