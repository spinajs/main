import { DI } from '@spinajs/di';
export const META_COMMAND = 'cli:command';
export const META_ARGUMENT = 'cli:argument';
export const META_OPTION = 'cli:options';
export function Command(nameAndArgsOrConfig, description, opts) {
    return function (target) {
        const meta = typeof nameAndArgsOrConfig === 'string'
            ? { nameAndArgs: nameAndArgsOrConfig, description: description ?? '', opts }
            : nameAndArgsOrConfig;
        Reflect.defineMetadata(META_COMMAND, meta, target);
        DI.register(target).as('__cli_command__');
    };
}
export function Option(flagsOrConfig, required, description, defaultValue, parser) {
    return function (target) {
        const arg = typeof flagsOrConfig === 'string'
            ? {
                flags: flagsOrConfig,
                description,
                defaultValue,
                required,
                parser: parser,
            }
            : flagsOrConfig;
        // copy: getMetadata also returns a decorated parent's list, which must stay untouched.
        const args = [...(Reflect.getMetadata(META_OPTION, target) ?? [])];
        // stacked decorators apply bottom-up, so unshift to preserve the
        // top-to-bottom declaration order.
        args.unshift(arg);
        Reflect.defineMetadata(META_OPTION, args, target);
    };
}
export function Argument(nameOrConfig, required, description, defaultValue, parser) {
    return function (target) {
        const arg = typeof nameOrConfig === 'string'
            ? {
                name: nameOrConfig,
                description,
                defaultValue,
                required,
                parser: parser,
            }
            : nameOrConfig;
        // copy: getMetadata also returns a decorated parent's list, which must stay untouched.
        const args = [...(Reflect.getMetadata(META_ARGUMENT, target) ?? [])];
        // stacked decorators apply bottom-up, so unshift to preserve the
        // top-to-bottom declaration order.
        args.unshift(arg);
        Reflect.defineMetadata(META_ARGUMENT, args, target);
    };
}
//# sourceMappingURL=decorators.js.map