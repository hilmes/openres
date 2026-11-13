import { GuestPage } from '@/components/openres/GuestPage';
import { localMode } from '@/lib/openres/store';
import { dateSchema, timeSchema } from '@/lib/openres/model';
import { venue } from '@/config/venue';
export const dynamic = 'force-dynamic';
export const metadata = { title: `${venue.name} · OpenRes` };
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const date = dateSchema.safeParse(params.date);
  const time = timeSchema.safeParse(params.time);
  const size = Number(params.partySize);
  return <GuestPage local={localMode()} initialDate={date.success ? date.data : undefined} initialTime={time.success ? time.data : undefined} initialPartySize={Number.isInteger(size) && size >= 1 && size <= 8 ? size : 2} initialFixtureId={typeof params.fixture === 'string' ? params.fixture : undefined} />;
}
