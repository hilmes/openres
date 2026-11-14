/**
 * What OpenRes needs from a payment provider to take a deposit. No provider is bundled:
 * an installation supplies one in src/config/payments.ts. Card details never reach OpenRes;
 * the provider's own form collects them in the browser using the client secret.
 * Amounts are integer minor units (cents).
 */
export type PaymentAdapter = {
  /** ISO 4217 code, lower case, e.g. "usd". */
  currency: string;
  /** Start a payment. Must be idempotent for a reservation: a retry returns the same payment. */
  create(input: { reservationId: string; amount: number; description: string }): Promise<{ id: string; clientSecret: string }>;
  /** Whether the payment succeeded, and for how much. */
  status(id: string): Promise<{ paid: boolean; amount: number }>;
  /** Return a succeeded payment in full. */
  refund(id: string): Promise<void>;
  /** Abandon a payment that never succeeded so it cannot be completed later. */
  cancel(id: string): Promise<void>;
};
