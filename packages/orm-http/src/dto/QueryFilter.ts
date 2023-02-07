import { Hydrator } from "@spinajs/http";
import { GetFilterHydrator } from "../hydrators/QueryFilterHydrator.js";

@Hydrator(GetFilterHydrator)
export class QueryFilter {
    [key: string]: any;

    constructor(data: any) {
        Object.assign(this, data);
    }
}