import 'server-only';
import { Resend } from 'resend';
import { venue } from '@/config/venue';
import { dateLabel, timeLabel, matchLabel, moneyLabel, STATUS_LABEL, type Reservation } from './model';
import { localMode } from './store';
import { managementToken } from './service';
export async function sendReservationEmail(reservation: Reservation) {
  if (localMode() || !process.env.RESEND_API_KEY || !process.env.OPENRES_EMAIL_FROM || !reservation.email) return false;
  // Nothing is confirmed until the deposit is paid.
  if (reservation.payment?.status === 'pending') return false;
  try {
    const base = new URL(process.env.OPENRES_BASE_URL || '');
    if (base.protocol !== 'https:' && process.env.NODE_ENV === 'production') return false;
    const link = `${base.origin}/manage#${reservation.id}.${managementToken(reservation.id)}`;
    const deposit = reservation.payment ? `Deposit: ${moneyLabel(reservation.payment.amount, reservation.payment.currency)} ${({ paid: 'paid. It comes off your bill.', applied: 'applied to your bill.', refunded: 'refunded.', forfeited: 'kept under the cancellation policy.', void: 'not taken.', pending: 'pending.' })[reservation.payment.status]}\n` : '';
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.OPENRES_EMAIL_FROM, replyTo: venue.contactEmail, to: reservation.email,
      subject: `${venue.name} — ${STATUS_LABEL[reservation.status].toLowerCase()} · ${dateLabel(reservation.date)}`,
      text: `Hi ${reservation.name},\n\nYour reservation at ${venue.name} is ${STATUS_LABEL[reservation.status].toLowerCase()}.\n\n${dateLabel(reservation.date)} at ${timeLabel(reservation.time)} (${venue.timeZone})\n${reservation.partySize} guests\n${venue.features.fixtures ? matchLabel(reservation.match) + '\n' : ''}${venue.address}\n${deposit}\n${reservation.status === 'waitlisted' ? 'A table is not yet confirmed.\n\n' : ''}View, change or cancel your reservation:\n${link}\n\nKeep this private link safe. Anyone with it can manage the reservation.\n\n${venue.name}`,
    }, { idempotencyKey: `openres/${reservation.id}/${reservation.version}` });
    return !error;
  } catch { console.error('[openres] confirmation delivery failed'); return false; }
}

/** Tell a waitlisted party a table is being held for them, with the deadline and their private link. */
export async function sendOfferEmail(reservation: Reservation) {
  if (localMode() || !process.env.RESEND_API_KEY || !process.env.OPENRES_EMAIL_FROM || !reservation.email || !reservation.offer) return false;
  try {
    const base = new URL(process.env.OPENRES_BASE_URL || '');
    if (base.protocol !== 'https:' && process.env.NODE_ENV === 'production') return false;
    const link = `${base.origin}/manage#${reservation.id}.${managementToken(reservation.id)}`;
    const until = new Date(reservation.offer.expiresAt).toLocaleTimeString(venue.locale, { hour: 'numeric', minute: '2-digit', timeZone: venue.timeZone });
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.OPENRES_EMAIL_FROM, replyTo: venue.contactEmail, to: reservation.email,
      subject: `${venue.name}: a table is ready for you until ${until}`,
      text: `Hi ${reservation.name},\n\nA table has opened at ${venue.name} for ${dateLabel(reservation.date)} at ${timeLabel(reservation.time)}, ${reservation.partySize} guests.\n\nWe are holding it for you until ${until} (${venue.timeZone}). Confirm it here:\n${link}\n\nIf you do not confirm by then, it goes to the next party and you stay on the waitlist.\n\nKeep this private link safe. Anyone with it can manage the reservation.\n\n${venue.name}`,
    }, { idempotencyKey: `openres/offer/${reservation.id}/${reservation.offer.offeredAt}` });
    return !error;
  } catch { console.error('[openres] offer delivery failed'); return false; }
}
