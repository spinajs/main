import type { Class } from '@spinajs/di';
import type { ResourceType } from '@spinajs/authz';
import type { ModelBase } from '@spinajs/orm';
import type { ResourceExtractor } from '../api.js';
/** A model instance `fromModel` made: only its primary key is set. */
export declare function isUnloadedModel(value: unknown): value is ModelBase;
/** What an extractor built here declares about itself, for boot checks and swagger. */
export interface ExtractorInfo {
    readonly type?: ResourceType;
    readonly from?: 'param' | 'body' | 'query' | 'model';
    readonly name?: string;
    /** `fromParam(…, { by })`: the field of the resource the value identifies. */
    readonly by?: string;
    readonly model?: Class<ModelBase>;
}
/** Marks the resource type a custom extractor yields, so boot checks and swagger can read it. */
export declare function typedExtractor(type: ResourceType, fn: ResourceExtractor): ResourceExtractor;
export declare function extractorInfo(extractor: ResourceExtractor | undefined): ExtractorInfo | undefined;
/** The type an extractor declared; undefined for a custom one or `fromModel` (the adapter knows it). */
export declare function extractorType(extractor: ResourceExtractor | undefined): ResourceType | undefined;
/**
 * `{ type, id }` from a url parameter. `by` names the field of the resource the value identifies
 * (e.g. `Uuid` for users); refs carry that value as their id, so it is documentation for swagger.
 */
export declare function fromParam(param: string, type: ResourceType, opts?: {
    by?: string;
}): ResourceExtractor;
/** `{ type, id }` from a dotted path of the request body. */
export declare function fromBody(path: string, type: ResourceType): ResourceExtractor;
/** `{ type, id }` from a query parameter. */
export declare function fromQuery(param: string, type: ResourceType): ResourceExtractor;
/**
 * An unloaded instance of `model` holding the url parameter as its primary key. AccessPolicy asks the
 * domain's adapter for its ref (the type `@AccessResource` declares) and checks that ref, never the
 * instance (design §11.2, §12.3).
 */
export declare function fromModel(model: Class<ModelBase>, param: string): ResourceExtractor;
//# sourceMappingURL=extractors.d.ts.map