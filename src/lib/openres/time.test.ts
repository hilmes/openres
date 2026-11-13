// @vitest-environment node
import { expect, it } from 'vitest';
import { wallTimeToISO } from './time';
it.each([
  ['2026-11-13', '18:00', 'America/New_York', '2026-11-13T23:00:00.000Z'],
  ['2026-07-13', '18:00', 'America/New_York', '2026-07-13T22:00:00.000Z'],
  ['2026-11-13', '18:00', 'Europe/London', '2026-11-13T18:00:00.000Z'],
  ['2026-11-13', '18:00', 'Asia/Kathmandu', '2026-11-13T12:15:00.000Z'],
  ['2026-11-13', '18:00', 'Pacific/Auckland', '2026-11-13T05:00:00.000Z'],
])('converts %s %s in %s', (date,time,zone,expected) => expect(wallTimeToISO(date,time,zone)).toBe(expected));
it.each([
  ['2026-03-08','02:30','America/New_York'],
  ['2026-11-01','01:30','America/New_York'],
  ['2026-03-29','01:30','Europe/London'],
  ['2026-10-25','01:30','Europe/London'],
])('rejects missing or repeated wall-clock times %s %s %s', (date,time,zone) => expect(() => wallTimeToISO(date,time,zone)).toThrow('missing or ambiguous'));
