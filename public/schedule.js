export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function validateSchedule(input) {
  if (!input || typeof input !== 'object') throw new Error('Give a schedule.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 200) throw new Error('Name must contain 1–200 characters.');
  const days = input.days;
  if (!Array.isArray(days) || !days.length || days.length > 7 || days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(days).size !== days.length) throw new Error('Choose at least one day (0 = Sunday through 6 = Saturday).');
  if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('Time must be HH:MM in the 24-hour clock.');
  const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
  if (!timeZone || timeZone.length > 100 || /^[+-]/.test(timeZone)) throw new Error('Give an IANA time zone such as Europe/London.');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw new Error('Give an IANA time zone such as Europe/London.'); }
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message || message.length > 19780) throw new Error('Message must contain 1–19780 characters.');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Enabled must be true or false.');
  return { name, days: [...days].sort(), time: input.time, timeZone, message, enabled: input.enabled ?? true };
}
