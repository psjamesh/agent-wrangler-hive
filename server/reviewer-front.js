export async function readReviewerFront(host) {
  if (typeof host?.agents?.front !== 'function') return { error: 'Host model front unavailable (requires API 1.92.0); using configured policy.' };
  try {
    const result = await host.agents.front();
    if (!Array.isArray(result?.front)) throw new Error('Invalid model front');
    return result;
  } catch { return { error: 'Host model front could not be read; using configured policy.' }; }
}
