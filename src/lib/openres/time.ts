/** IANA wall-clock conversion, including non-hour offsets and DST gaps/folds. */
export function wallParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: string) => parts.find(p => p.type === type)!.value;
  return { date: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}`, seconds: value('second') };
}
export function wallTimeToISO(date: string, time: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid local date or time');
  const wall = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 10) !== date) throw new Error('Invalid date');
  const offsets = new Set<number>();
  // Sample both sides of timezone transitions without assuming US DST rules.
  for (let hours = -36; hours <= 36; hours += 3) {
    const sample = wall + hours * 3_600_000;
    const parts = wallParts(new Date(sample), timeZone);
    offsets.add(Date.parse(`${parts.date}T${parts.time}:${parts.seconds}Z`) - sample);
  }
  const candidates = [...offsets].map(offset => new Date(wall - offset)).filter(instant => {
    const parts = wallParts(instant, timeZone);
    return parts.date === date && parts.time === time && parts.seconds === '00';
  });
  if (candidates.length !== 1) throw new Error('This local time is missing or ambiguous because of a timezone transition');
  return candidates[0].toISOString();
}
