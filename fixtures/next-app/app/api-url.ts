export function apiUrl(): string {
  const url = process.env.SPINAJS_API_URL;
  if (!url) throw new Error('SPINAJS_API_URL is not set; scripts/e2e.mjs sets it to the app-basic server');
  return url;
}
