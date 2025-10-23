const loadOrder = [];

export async function resolve(specifier, context, nextResolve) {
  console.log(`[RESOLVE] ${specifier}`);
  console.log(`          from: ${context.parentURL || 'entry point'}`);

  const result = await nextResolve(specifier, context);
  console.log(`          resolved to sss: ${result.url}`);
  return result;
}

export async function load(url, context, nextLoad) {
  const filename = url.split('/').pop();
  console.log(`\n[LOAD] Loading: ${filename}`);
  console.log(`       Full URL: ${url}`);
  loadOrder.push(filename);
  try {
    const result = await nextLoad(url, context);

    if (url.includes('packages/orm')) {
      console.log(`[LOAD] ✓ Successfully loaded: ${url.split('/').pop()}`);
    }

    return result;
  } catch (error) {
    console.error(`\n[LOAD ERROR] Failed to load: ${url}`);
    console.error(`[LOAD ERROR] Error:`, error.message);
    console.error(`[LOAD ERROR] Load order so far:`, loadOrder);
    throw error;
  }
}