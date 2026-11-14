import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagePage } from "./ManagePage";

const id = "550e8400-e29b-41d4-a716-446655440000";
const base = { id, date: "2026-11-21", time: "18:00", partySize: 2, area: "any", duration: 90, name: "Sample Guest", email: "guest@example.com", phone: "", notes: "", occasion: "", source: "online", createdAt: "", updatedAt: "", version: 2, match: { kind: "none" } };
let sent: { url: string; method?: string; body?: unknown }[];
function serve(first: unknown, afterPatch?: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    sent.push({ url, method: options?.method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return { ok: true, status: 200, json: async () => ({ reservation: options?.method === "PATCH" ? afterPatch : first, emailed: false }) };
  }));
}
beforeEach(() => {
  sent = [];
  window.location.hash = `#${id}.token`;
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => vi.unstubAllGlobals());

it("lets a waitlisted guest confirm a table that is being held for them", async () => {
  serve({ ...base, status: "waitlisted", offer: { expiresAt: new Date(Date.now() + 10 * 60000).toISOString() } }, { ...base, status: "confirmed", version: 3 });
  render(<ManagePage />);
  expect(await screen.findByText("A table is ready for you.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Confirm my table" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ url: `/api/openres/reservations/${id}`, method: "PATCH", body: { status: "confirmed", version: 2 } }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm my table" })).toBeNull());
  expect(screen.getByText("Confirmed")).toBeVisible();
});

it("shows the plain waitlist message with no offer or once the offer has lapsed", async () => {
  serve({ ...base, status: "waitlisted", offer: { expiresAt: new Date(Date.now() - 60000).toISOString() } });
  render(<ManagePage />);
  expect(await screen.findByText(/You’re on the waitlist/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Confirm my table" })).toBeNull();
});
