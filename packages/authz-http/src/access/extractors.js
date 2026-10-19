import { InvalidArgument } from '@spinajs/exceptions';
const EXTRACTOR = Symbol.for('authz:access:extractor');
const UNLOADED = Symbol.for('authz:access:unloaded-model');
/** A model instance `fromModel` made: only its primary key is set. */
export function isUnloadedModel(value) {
    return typeof value === 'object' && value !== null && value[UNLOADED] === true;
}
function described(info, fn) {
    Object.defineProperty(fn, EXTRACTOR, { value: Object.freeze(info) });
    return fn;
}
/** Marks the resource type a custom extractor yields, so boot checks and swagger can read it. */
export function typedExtractor(type, fn) {
    return described({ type }, fn);
}
export function extractorInfo(extractor) {
    return extractor ? extractor[EXTRACTOR] : undefined;
}
/** The type an extractor declared; undefined for a custom one or `fromModel` (the adapter knows it). */
export function extractorType(extractor) {
    return extractorInfo(extractor)?.type;
}
function idOf(value, where) {
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    if (typeof value === 'string' && value.length > 0)
        return value;
    throw new InvalidArgument(`${where} is required to identify the resource`, where);
}
function readPath(source, path) {
    let value = source;
    for (const key of path.split('.')) {
        value = value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
    }
    return value;
}
/**
 * `{ type, id }` from a url parameter. `by` names the field of the resource the value identifies
 * (e.g. `Uuid` for users); refs carry that value as their id, so it is documentation for swagger.
 */
export function fromParam(param, type, opts) {
    return described({ type, from: 'param', name: param, ...(opts?.by !== undefined ? { by: opts.by } : {}) }, (req) => ({ type, id: idOf(req.params?.[param], `url parameter ${param}`) }));
}
/** `{ type, id }` from a dotted path of the request body. */
export function fromBody(path, type) {
    return described({ type, from: 'body', name: path }, (req) => ({ type, id: idOf(readPath(req.body, path), `body.${path}`) }));
}
/** `{ type, id }` from a query parameter. */
export function fromQuery(param, type) {
    return described({ type, from: 'query', name: param }, (req) => ({ type, id: idOf(req.query?.[param], `query parameter ${param}`) }));
}
/**
 * An unloaded instance of `model` holding the url parameter as its primary key. AccessPolicy asks the
 * domain's adapter for its ref (the type `@AccessResource` declares) and checks that ref, never the
 * instance (design §11.2, §12.3).
 */
export function fromModel(model, param) {
    return described({ from: 'model', name: param, model }, (req) => {
        const instance = new model();
        instance.PrimaryKeyValue = idOf(req.params?.[param], `url parameter ${param}`);
        Object.defineProperty(instance, UNLOADED, { value: true });
        return instance;
    });
}
//# sourceMappingURL=extractors.js.map