import { BaseSocketController } from '@spinajs/http-socket';
export declare abstract class FeedSocket<T> extends BaseSocketController {
    publish(item: T): Promise<T>;
    follow(): AsyncIterable<T>;
    changed(item: T): void;
    renamed(item: T): void;
}
