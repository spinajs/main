import { startTeamsApp, stopTeamsApp } from './support/app.js';

// One app and one database for the whole run; cases keep apart by fresh ids (support/client.ts uniq).
before(async function () {
  this.timeout(120_000);
  await startTeamsApp();
});

after(async () => {
  await stopTeamsApp();
});
