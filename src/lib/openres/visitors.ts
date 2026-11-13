import type { Reservation } from './model';

/** Contact evidence, not verified identity. Never merge guests by name. */
export function visitorContact(record: Pick<Reservation, 'email' | 'phone'>): { kind: 'email' | 'phone'; value: string } | null {
  const email = record.email.trim().toLowerCase();
  if (email) return { kind: 'email', value: email };
  const phone = record.phone.replace(/\D/g, '');
  return phone.length >= 7 && phone.length <= 15 ? { kind: 'phone', value: phone } : null;
}
