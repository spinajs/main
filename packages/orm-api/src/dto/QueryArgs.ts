import { SortOrder } from "@spinajs/orm";
import { Schema } from "@spinajs/validation";
import QueryArgsSchema from "../schemas/QueryArgs.schema.js";

@Schema(QueryArgsSchema)
export class QueryArgs {
  public page?: number;
  public perPage?: number;
  public orderDirection?: SortOrder;
  public order?: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}
