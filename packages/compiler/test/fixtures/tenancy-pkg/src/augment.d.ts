declare module '@spinajs/queue' {
  interface JobOptions {
    tenancy?: 'carry' | 'required' | 'none';
  }
}

declare module '@spinajs/scheduler' {
  interface ScheduleOptions {
    tenancy?: 'none' | 'each';
  }
}

export {};
