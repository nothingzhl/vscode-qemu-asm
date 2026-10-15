/** Release every owned resource before surfacing the first cleanup error. */
export async function releaseAll(actions: readonly (() => unknown | Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(actions.map((action) => Promise.resolve().then(action)));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
