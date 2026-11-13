import { fixtures } from '@/config/fixtures';
import { bookingFixtures } from '@/lib/openres/fixtures';
import { attestFixture } from '@/lib/openres/service';
import { addDays, venueNow } from '@/lib/openres/model';
import { localMode } from '@/lib/openres/store';
import { handle, json } from '@/lib/openres/http';
export const dynamic = 'force-dynamic';
export async function GET() {
  return handle(async () => {
    const date = addDays(venueNow().date, 1);
    const catalog = localMode() ? [
      { id: 'demo-1', date, time: '18:00', home: 'Home team', away: 'Away team', competition: 'Demo fixture' },
      { id: 'demo-2', date, time: '20:00', home: 'North team', away: 'South team', competition: 'Demo fixture' },
    ] : bookingFixtures(fixtures);
    return json({ fixtures: catalog.map(f => attestFixture(f)), local: localMode() });
  });
}
