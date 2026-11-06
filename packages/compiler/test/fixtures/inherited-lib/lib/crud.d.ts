import { BaseController, Ok } from '@spinajs/http';
export type FileDto = { id: string; size: number };
export declare abstract class StoreController<T> extends BaseController {
    get(id: string): Promise<Ok<T>>;
    remove(id: string): Promise<Ok<null>>;
}
export declare abstract class Undocumented extends BaseController {
    ping(): Promise<Ok<string>>;
}
