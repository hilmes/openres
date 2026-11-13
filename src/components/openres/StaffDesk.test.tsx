import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StaffDesk } from "./StaffDesk";
import {
  DEFAULT_SETTINGS,
  venueNow,
  type Reservation,
} from "@/lib/openres/model";
let reservation: Reservation;
let unauthorized = false;
let mutations: Record<string, unknown>[];
beforeEach(() => {
  unauthorized = false;
  mutations = [];
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  reservation = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    date: venueNow().date,
    time: "18:00",
    partySize: 2,
    area: "any",
    tableId: "11",
    duration: 90,
    name: "Private Guest",
    email: "private@example.com",
    phone: "2125550100",
    notes: "",
    staffNotes: "",
    occasion: "",
    status: "confirmed",
    source: "phone",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    history: [],
    match: { kind: "none" },
  };
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === "PATCH") {
        const patch = JSON.parse(String(options.body));
        mutations.push(patch);
        reservation = {
          ...reservation,
          ...patch,
          version: reservation.version + 1,
        };
        return {
          ok: true,
          json: async () => ({ reservation, emailed: false }),
        };
      }
      if (url.includes("/lock"))
        return { ok: true, json: async () => ({ locked: true }) };
      return unauthorized
        ? {
            ok: false,
            status: 401,
            json: async () => ({ error: "Sign in to continue" }),
          }
        : {
            ok: true,
            json: async () => ({
              reservations: [reservation],
              settings: DEFAULT_SETTINGS,
              manager: false,
              local: true,
            }),
          };
    }),
  );
});
it("opens with the real floor beside the guest list and assigns a table by touch", async () => {
  render(<StaffDesk local />);
  await screen.findByRole("button", { name: /Private Guest/ });
  expect(
    screen.getByRole("group", { name: /Venue floor plan/ }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Guest book" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Private Guest/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Choose table on floor" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Table 12, 2 seats/ }));
  await waitFor(() =>
    expect(mutations).toEqual([
      expect.objectContaining({
        id: reservation.id,
        version: 1,
        tableId: "12",
      }),
    ]),
  );
  await screen.findByText("Reservation updated.");
});
it("removes displayed guest data when staff authorization expires", async () => {
  render(<StaffDesk local />);
  await screen.findByRole("button", { name: /Private Guest/ });
  unauthorized = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh reservations" }));
  await screen.findByText("Sign in to continue");
  expect(screen.queryByText("Private Guest")).not.toBeInTheDocument();
  expect(screen.queryByText("private@example.com")).not.toBeInTheDocument();
});
it("clears guest data when the shared iPad tab is hidden", async () => {
  render(<StaffDesk local />);
  await screen.findByRole("button", { name: /Private Guest/ });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.getByText("Guest details hidden")).toBeVisible();
  expect(screen.queryByText("Private Guest")).not.toBeInTheDocument();
});
it("locks the desk and clears rendered personal data before the request completes", async () => {
  render(<StaffDesk local />);
  await screen.findByRole("button", { name: /Private Guest/ });
  fireEvent.click(screen.getByRole("button", { name: "Lock desk" }));
  expect(screen.getByText("Guest details hidden")).toBeVisible();
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/openres/lock",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(screen.queryByText("Private Guest")).not.toBeInTheDocument();
});
