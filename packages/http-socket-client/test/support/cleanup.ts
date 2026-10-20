const open: Array<{ close(): void }> = [];

export function track<T extends { close(): void }>(closable: T): T {
  open.push(closable);
  return closable;
}

export function closeAll(): void {
  for (const closable of open.splice(0)) closable.close();
}
