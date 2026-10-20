export const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

export const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
