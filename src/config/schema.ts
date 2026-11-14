import './zod';
import { z } from 'zod';
const optionalUrl = z.union([z.literal(''), z.string().url().refine(value => /^https?:\/\//.test(value))]);
export const venueSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120), address: z.string().max(300), contactEmail: z.string().email(),
  timeZone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Use an IANA timezone'),
  locale: z.string().default('en-US'), website: optionalUrl, menuUrl: optionalUrl,
  features: z.object({ fixtures: z.boolean() }),
  floor: z.object({ width: z.number().min(400).max(4000), height: z.number().min(300).max(4000), label: z.string().min(1), revision: z.string().min(1) }),
  areas: z.record(z.string().regex(/^(?!any$)[a-z][a-z0-9_-]*$/), z.string().min(1)),
  tables: z.array(z.object({ id: z.string().min(1).max(30), seats: z.number().int().min(1).max(20), area: z.string(), x: z.number().min(.05).max(.95), y: z.number().min(.05).max(.95), shape: z.enum(['round','square','rect']) })).min(1),
}).superRefine((venue, context) => {
  if (new Set(venue.tables.map(t => t.id)).size !== venue.tables.length) context.addIssue({ code: 'custom', message: 'Table IDs must be unique' });
  if (venue.tables.some(t => !Object.hasOwn(venue.areas, t.area))) context.addIssue({ code: 'custom', message: 'Every table needs a configured area' });
});
