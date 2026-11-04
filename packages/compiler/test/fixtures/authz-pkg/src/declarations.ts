// Stand-ins for decorators the compiler reads by name; the packages that ship them come later.
export function SystemTask(reason: string): ClassDecorator {
  void reason;
  return () => undefined;
}

export function Job(options: { runAs?: 'initiator' | 'system'; access?: string | string[] }): ClassDecorator {
  void options;
  return () => undefined;
}
