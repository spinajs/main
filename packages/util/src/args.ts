import { InvalidArgument } from '@spinajs/exceptions';

export function _check_arg(...checks: ((arg: any, name: string) => any)[]) {
    return function (arg: any, name: string) {
        for (const check of checks) {
            arg = check(arg, name);
        }

        return arg;
    };
}

export function _number(...checks: ((arg: number, name: string) => number)[]) {
    return function (arg: any, name: string) {
        if (typeof arg !== 'number') {
            throw new InvalidArgument(`${name} should be number`);
        }

        for (const check of checks) {
            arg = check(arg, name);
        }

        return arg;
    };
}

export function _string(...checks: ((arg: string, name: string) => string)[]) {
    return function (arg: string, name: string) {

        if (typeof arg !== 'string') {
            throw new InvalidArgument(`${name} should be string`);
        }

        for (const check of checks) {
            arg = check(arg, name);
        }

        return arg;
    };
}

export function _trim() {
    return function (arg: string, _name: string) {
        return arg.trim();
    };
}

export function _min_length(length: number) {
    return function (arg: string, name: string) {
        if (arg.length < length) {
            throw new InvalidArgument(`${name} should be at least ${length} characters`);
        }

        return arg;
    };
}

export function _max_length(length: number) {
    return function (arg: string, name: string) {
        if (arg.length > length) {
            throw new InvalidArgument(`${name} should be at most ${length} characters`);
        }

        return arg;
    };
}

export function _min(value: number) {
    return function (arg: number, name: string) {
        if (arg < value) {
            throw new InvalidArgument(`${name} should be at least ${value}`);
        }

        return arg;
    };
}

export function _max(value: number) {
    return function (arg: number, name: string) {
        if (arg > value) {
            throw new InvalidArgument(`${name} should be at most ${value}`);
        }

        return arg;
    };
}

export function _non_null() {
    return function (arg: any, name: string) {
        if (arg === null || arg === undefined) {
            throw new InvalidArgument(`${name} should not be null`);
        }

        return arg;
    };
}

export function _non_undefined() {
    return function (arg: any, name: string) {
        if (arg === undefined) {
            throw new InvalidArgument(`${name} should not be undefined`);
        }

        return arg;
    };
}

export function _non_nil() {
    return function (arg: any, name: string) {
        if (arg === null || arg === undefined) {
            throw new InvalidArgument(`${name} should not be null`);
        }

        return arg;
    };
}

export function _non_empty() {
    return function (arg: string | any[], name: string) {
        if (arg.length === 0) {
            throw new InvalidArgument(`${name} should not be empty`);
        }

        return arg;
    };
}

