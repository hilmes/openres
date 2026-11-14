"use client";
import { createContext, createElement, useContext, type ComponentType, type ReactNode } from "react";

/** The provider's card form. It collects the card itself and reports back; OpenRes never sees card details. */
export type PaymentFormProps = {
  clientSecret: string;
  /** Integer minor units (cents). */
  amount: number;
  currency: string;
  onPaid: () => void;
  onError: (message: string) => void;
};
const PaymentFormContext = createContext<ComponentType<PaymentFormProps> | null>(null);

/** Supplies the card form for deposits to every OpenRes component beneath it. */
export function OpenResPaymentProvider({ form, children }: { form: ComponentType<PaymentFormProps>; children: ReactNode }) {
  return <PaymentFormContext.Provider value={form}>{children}</PaymentFormContext.Provider>;
}
/** Renders the installation's card form, or the fallback when none is supplied. */
export function PaymentSlot({ fallback, ...props }: PaymentFormProps & { fallback: ReactNode }) {
  const form = useContext(PaymentFormContext);
  return form ? createElement(form, props) : fallback;
}
