const DAY = 86400000;

export function nextRunAt(schedule, after = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = at => Object.fromEntries(formatter.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const stamp = p => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const today = parts(after);
  const [hour, minute] = schedule.time.split(':').map(Number);
  const start = Date.UTC(today.year, today.month - 1, today.day, hour, minute);
  for (let day = 0; day < 15; day++) {
    const nominal = start + day * DAY;
    if (!schedule.days.includes(new Date(nominal).getUTCDay())) continue;
    const offsets = new Set([-36, -12, 0, 12, 36].map(h => {
      const at = nominal + h * 3600000;
      return stamp(parts(at)) - at;
    }));
    const candidates = [...offsets].map(offset => nominal - offset).filter(at => stamp(parts(at)) === nominal).sort((a, b) => a - b);
    // A repeated wall-clock time runs at its first occurrence; a missing time skips that date.
    if (candidates.length && candidates[0] > after) return candidates[0];
  }
  throw new Error('Could not find the next scheduled time.');
}
