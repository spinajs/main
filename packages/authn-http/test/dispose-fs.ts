import 'mocha';
import { DI } from '@spinajs/di';
import { FILE_PROVIDER_INSTANCES } from '@spinajs/fs';
import type { fs } from '@spinajs/fs';

// The suites resolve fsService and never dispose it: fsTemp's hourly cleanup interval would keep the process alive.
after(async function () {
  for (const provider of DI.get<Map<string, fs>>(FILE_PROVIDER_INSTANCES)?.values() ?? []) await provider.dispose();
});
