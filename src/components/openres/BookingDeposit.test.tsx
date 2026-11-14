import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookingWidget } from "./BookingWidget";
import { OpenResPaymentProvider, type PaymentFormProps } from "./payment";
import { addDays, venueNow } from "@/lib/openres/model";

const date = addDays(venueNow().date, 1);
let calls: { url: string; method?: string; auth?: string | null }[];
beforeEach(() => {
  calls = [];
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, method: options?.method, auth: new Headers(options?.headers).get("Authorization") });
    const reservation = { id: "550e8400-e29b-41d4-a716-446655440000", date, time: "18:00", partySize: 2, status: "confirmed", duration: 90, match: { kind: "none" } };
    if (url.includes("availability"))
      return { ok: true, json: async () => ({ slots: [{ time: "18:00", areas: ["tables"] }], enabled: true, advanceDays: 30, duration: 90, deposit: { enabled: true, perGuest: 2000, minParty: 1, fixturesOnly: false, refundHours: 24, payMinutes: 10, currency: "usd" } }) };
    if (url.endsWith("/reservations"))
      return { ok: true, json: async () => ({ reservation: { ...reservation, payment: { amount: 4000, currency: "usd", status: "pending" } }, token: "private-token", emailed: false, payment: { clientSecret: "pi_secret", amount: 4000, currency: "usd" } }) };
    return { ok: true, json: async () => ({ reservation: { ...reservation, payment: { amount: 4000, currency: "usd", status: "paid" } }, emailed: true }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

/** Stands in for the provider's card form. */
function CardForm({ clientSecret, amount, onPaid }: PaymentFormProps) {
  return <button onClick={onPaid}>Pay {amount} with {clientSecret}</button>;
}
async function fillAndSubmit() {
  fireEvent.click(await screen.findByRole("button", { name: /6:00 PM/ }));
  expect(screen.getByText(/\$40\.00 deposit today/)).toBeVisible();
  expect(screen.getByText(/Refunded if you cancel at least 24 hours before/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Sample Guest" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: /Continue to deposit/ }));
}

it("shows the deposit before the guest commits, then confirms only after the server has checked the payment", async () => {
  render(<OpenResPaymentProvider form={CardForm}><BookingWidget initialDate={date} initialMatch={{ kind: "none" }} /></OpenResPaymentProvider>);
  await fillAndSubmit();
  // Held, not confirmed: the card form is up and there is no confirmation yet.
  const payButton = await screen.findByRole("button", { name: "Pay 4000 with pi_secret" });
  expect(screen.queryByText("Your reservation is confirmed")).toBeNull();
  fireEvent.click(payButton);
  await waitFor(() => expect(calls.at(-1)).toMatchObject({ url: "/api/openres/reservations/550e8400-e29b-41d4-a716-446655440000", method: "POST", auth: "Bearer private-token" }));
  expect(await screen.findByText("Your reservation is confirmed")).toBeVisible();
  expect(screen.getByText(/\$40\.00 deposit paid/)).toBeVisible();
});

it("says so plainly when no card form is installed, instead of confirming", async () => {
  render(<BookingWidget initialDate={date} initialMatch={{ kind: "none" }} />);
  await fillAndSubmit();
  expect(await screen.findByRole("alert")).toHaveTextContent("Card payment is not set up here");
  expect(screen.queryByText("Your reservation is confirmed")).toBeNull();
});
