import { Injectable } from "@spinajs/di";
import { ModelBase } from "@spinajs/orm";
import { CollectionApiTransformer, ITransformOptions } from "./interfaces.js";

/**
 * Plain json collection transformer, used by default.
 */
@Injectable(CollectionApiTransformer)
export class PlainJsonCollectionTransformer extends CollectionApiTransformer {
    public transform(data: ModelBase<unknown> | ModelBase<unknown>[], options?: ITransformOptions): unknown {

        if (Array.isArray(data)) {
            return {
                Collection: data.map(x => x.toJSON()),
                Count: options.totalCount,
            }
        }

        return data.toJSON();

    }
}