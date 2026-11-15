// Package config merges before the app's, so an app's db.Aliases.workflow and workflow.* win.
const workflow = {
  db: {
    Aliases: {
      workflow: 'default',
    },
  },
  system: {
    dirs: {
      // Apps append their workflow folders; the files are imported so their @Workflow decorators run.
      workflows: [] as string[],
    },
  },
  workflow: {
    enabled: true,
    tick: 1000,
    concurrency: 10,
    leaseTtl: 60000,
    shutdownGrace: 30000,
    maxStepResultBytes: 262144,
    compensateOnCancel: false,
    retry: { attempts: 3, backoff: 'exponential', delay: '1s', maxDelay: '5m' },
  },
};

export default workflow;
