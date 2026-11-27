import { HTTP_STATUS_CODE, Ok } from '@spinajs/http';
export function helper() {
    class Decoy {
        constructor() {
            this._errorCode = 500;
        }
    }
    return new Decoy();
}
export class Decoy extends Ok {
    constructor() {
        super(...arguments);
        this._errorCode = HTTP_STATUS_CODE.NOT_FOUND;
    }
}
