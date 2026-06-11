import { join } from 'path';

function lib(...path: string[]) {
    return join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'http-progress', 'lib', ...path);
}

function dir(path: string) {
    const inCommonJs = typeof (module as any) !== 'undefined';
    return [
        join(lib(), inCommonJs ? 'cjs' : 'mjs', path),
    ];
}

const config = {
    system: {
        dirs: {
            controllers: [...dir('controllers')],
        },
    },
};

export default config;
