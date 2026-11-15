export async function readReviewerFront(host, { timeoutMs = 5000 } = {}) {
  if (typeof host?.agents?.front !== 'function') return { error: 'Host model front unavailable (requires API 1.92.0); using configured policy.' };
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => host.agents.front()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Model front timed out')), timeoutMs); }),
    ]);
    if (!Array.isArray(result?.front)) throw new Error('Invalid model front');
    return result;
  } catch { return { error: 'Host model front could not be read within its deadline; using configured policy.' }; }
  finally { clearTimeout(timer); }
}
