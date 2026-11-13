/** Public configuration: bundled into the guest and staff UI. Never put secrets here. */
import { venueSchema } from './schema';
export const venue = venueSchema.parse({
  id: 'example-restaurant',
  name: 'Your Restaurant',
  address: '123 Example Street',
  contactEmail: 'hello@example.com',
  timeZone: 'America/New_York',
  locale: 'en-US',
  website: '',
  menuUrl: '',
  features: { fixtures: false },
  floor: { width: 900, height: 650, label: 'Main floor', revision: 'example-layout-v1' },
  areas: { tables: 'Dining room', window: 'Window', bar: 'Bar area' },
  tables: [
    { id: '11', seats: 2, area: 'tables', x: .22, y: .27, shape: 'round' },
    { id: '12', seats: 2, area: 'tables', x: .46, y: .27, shape: 'round' },
    { id: '13', seats: 4, area: 'tables', x: .70, y: .27, shape: 'square' },
    { id: '14', seats: 4, area: 'tables', x: .22, y: .60, shape: 'square' },
    { id: '15', seats: 6, area: 'tables', x: .46, y: .60, shape: 'rect' },
    { id: '16', seats: 8, area: 'tables', x: .70, y: .60, shape: 'rect' },
    { id: '21', seats: 2, area: 'window', x: .15, y: .86, shape: 'round' },
    { id: '31', seats: 4, area: 'bar', x: .85, y: .86, shape: 'rect' },
  ],
});
