import 'server-only';
import { Resend } from 'resend';
import { venue } from '@/config/venue';
import { dateLabel, timeLabel, matchLabel, STATUS_LABEL, type Reservation } from './model';
import { localMode } from './store';
import { managementToken } from './service';
export async function sendReservationEmail(reservation: Reservation) {
  if (localMode() || !process.env.RESEND_API_KEY || !process.env.OPENRES_EMAIL_FROM || !reservation.email) return false;
  try {
    const base = new URL(process.env.OPENRES_BASE_URL || '');
    if (base.protocol !== 'https:' && process.env.NODE_ENV === 'production') return false;
    const link = `${base.origin}/manage#${reservation.id}.${managementToken(reservation.id)}`;
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.OPENRES_EMAIL_FROM, replyTo: venue.contactEmail, to: reservation.email,
      subject: `${venue.name} — ${STATUS_LABEL[reservation.status].toLowerCase()} · ${dateLabel(reservation.date)}`,
      text: `Hi ${reservation.name},\n\nYour reservation at ${venue.name} is ${STATUS_LABEL[reservation.status].toLowerCase()}.\n\n${dateLabel(reservation.date)} at ${timeLabel(reservation.time)} (${venue.timeZone})\n${reservation.partySize} guests\n${venue.features.fixtures ? matchLabel(reservation.match) + '\n' : ''}${venue.address}\n\n${reservation.status === 'waitlisted' ? 'A table is not yet confirmed.\n\n' : ''}View, change or cancel your reservation:\n${link}\n\nKeep this private link safe. Anyone with it can manage the reservation.\n\n${venue.name}`,
    }, { idempotencyKey: `openres/${reservation.id}/${reservation.version}` });
    return !error;
  } catch { console.error('[openres] confirmation delivery failed'); return false; }
}
