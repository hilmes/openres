import type { PaymentAdapter } from '@/lib/openres/payments';
/**
 * The deposit provider for this installation, or null for none. With none, Settings cannot
 * switch deposits on and bookings never ask for payment. Server-only: keep keys in the
 * environment, never in this file.
 */
export const paymentAdapter: PaymentAdapter | null = null;
