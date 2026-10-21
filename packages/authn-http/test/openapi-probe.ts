// Runs in a fresh node process (ts-node/esm), so importing http-swagger leaks into no other suite: boots the v3 account
// app of test/v3-app and prints the OpenAPI document @spinajs/http-swagger builds for it.
import { DI } from '@spinajs/di';
import { SwaggerService } from '@spinajs/http-swagger';

import { bootApp, startServer, stopApp } from './v3-app/app.js';

await bootApp();
await startServer();
const spec = await ((await DI.resolve(SwaggerService)) as SwaggerService).buildSpec();
process.stdout.write(`<<JSON\n${JSON.stringify(spec)}\nJSON>>\n`);
await stopApp();
process.exit(0);
