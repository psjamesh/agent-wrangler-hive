export async function readReviewerFront(host, { timeoutMs = 5000, agents, builderAgent } = {}) {
  const version = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(host?.version || '');
  const restricted = version && (+version[1] > 1 || (+version[1] === 1 && +version[2] >= 94));
  if (restricted && Array.isArray(agents) && builderAgent === undefined) {
    const entries = await Promise.all(agents.filter(a => a.available === true).map(async a => [a.id, await readReviewerFront(host, { timeoutMs, agents, builderAgent: a.id })]));
    return { byBuilder: Object.fromEntries(entries), scope: 'eligible-front' };
  }
  const options = restricted && Array.isArray(agents) && builderAgent ? {
    agents: agents.filter(a => a.available === true && a.id !== builderAgent && !/terra/i.test(a.id)).map(a => a.id),
    excludeModels: [...new Set(agents.flatMap(a => (a.models || []).filter(m => /terra/i.test(`${m.value} ${m.resolved || ''}`)).map(m => m.value)))],
  } : null;
  if (typeof host?.agents?.front !== 'function') return { error: 'Host model front unavailable (requires API 1.92.0); using configured policy.' };
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => options ? host.agents.front(options) : host.agents.front()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Model front timed out')), timeoutMs); }),
    ]);
    if (!Array.isArray(result?.front)) throw new Error('Invalid model front');
    return options ? { ...result, scope: 'eligible-front' } : result;
  } catch { return { ...(options ? { scope: 'eligible-front' } : {}), error: 'Host model front could not be read within its deadline; using configured policy.' }; }
  finally { clearTimeout(timer); }
}
