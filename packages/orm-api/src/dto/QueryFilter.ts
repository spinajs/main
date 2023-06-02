import { Hydrator } from "@spinajs/http";
import { GetFilterHydrator } from "../hydrators/QueryFilterHydrator.js";
import { IQueryFilterEntry } from "../interfaces.js";
import QueryFilterSchema from "../schemas/QueryFilter.schema.js";
import { Schema } from "@spinajs/validation";

@Hydrator(GetFilterHydrator)
@Schema(QueryFilterSchema)
export class QueryFilter {
    [key: string]: IQueryFilterEntry;

    constructor(data: any) {
        Object.assign(this, data);
    }
}