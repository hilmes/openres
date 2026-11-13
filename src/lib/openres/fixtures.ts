import { fixtureSchema, venueNow, type BookingFixture } from './model';
/** No third-party fixture feed is enabled by default. */
export function bookingFixtures(fixtures: BookingFixture[], now = new Date()): BookingFixture[] {
  const clock = venueNow(now);
  return fixtures.map(f => fixtureSchema.parse(f))
    .filter(f => f.date > clock.date || (f.date === clock.date && f.time > `${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`))
    .sort((a,b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
}
export function bookingHref(fixture: BookingFixture) {
  return `/book?${new URLSearchParams({ fixture: fixture.id, date: fixture.date, time: fixture.time })}`;
}
