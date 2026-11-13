import { redirect } from 'next/navigation';
import { StaffDesk } from '@/components/openres/StaffDesk';
import { localMode } from '@/lib/openres/store';
import { currentStaff } from '@/lib/openres/auth';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reservation desk · OpenRes' };
export default async function Page() {
  if (!localMode() && !await currentStaff()) redirect('/staff/login');
  return <StaffDesk local={localMode()} />;
}
