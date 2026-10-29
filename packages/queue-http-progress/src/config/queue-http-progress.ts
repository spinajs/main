import { join } from 'path';

function lib(...path: string[]) {
    return join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'queue-http-progress', 'lib', ...path);
}

function dir(path: string) {
    return [
        join(lib(), path),
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
