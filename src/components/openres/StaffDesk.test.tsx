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
  addDays,
  DEFAULT_SETTINGS,
  venueNow,
  type Reservation,
} from "@/lib/openres/model";
let reservation: Reservation;
let unauthorized = false;
let mutations: Record<string, unknown>[];
let visits = 0;
beforeEach(() => {
  unauthorized = false;
  mutations = [];
  visits = 0;
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
              visitSummaries: { [reservation.id]: { completedVisits: visits, lastVisit: visits ? "2026-10-01" : null, matchedBy: reservation.email ? "email" : null } },
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
  await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ });
  expect(
    screen.getByRole("group", { name: /Venue floor plan/ }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Guest book" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^6:00 PM.*Private Guest/ }));
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
  await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ });
  unauthorized = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh reservations" }));
  await screen.findByText("Sign in to continue");
  expect(screen.queryByText("Private Guest")).not.toBeInTheDocument();
  expect(screen.queryByText("private@example.com")).not.toBeInTheDocument();
});
it("clears guest data when the shared iPad tab is hidden", async () => {
  render(<StaffDesk local />);
  await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ });
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
  await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ });
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

it("does not restore the previous service when a delayed save finishes after changing dates", async () => {
  const today = reservation.date;
  const tomorrow = addDays(today, 1);
  const nextGuest = { ...reservation, id: "550e8400-e29b-41d4-a716-446655440001", name: "Next Service Guest", date: tomorrow };
  let finishSave!: (response: unknown) => void;
  vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
    if (options?.method === "PATCH") return new Promise(resolve => { finishSave = resolve; });
    const serviceDate = new URL(url, "http://localhost").searchParams.get("date");
    return Promise.resolve({ ok: true, json: async () => ({ reservations: [serviceDate === tomorrow ? nextGuest : reservation], settings: DEFAULT_SETTINGS, manager: false, local: true }) });
  }));
  render(<StaffDesk local />);
  fireEvent.click(await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ }));
  fireEvent.click(screen.getByRole("button", { name: "Mark arrived" }));
  fireEvent.click(screen.getByRole("button", { name: "Next date" }));
  await screen.findByRole("button", { name: /^6:00 PM.*Next Service Guest/ });
  await act(async () => finishSave({ ok: true, json: async () => ({ reservation: { ...reservation, status: "arrived", version: 2 } }) }));
  expect(screen.getByRole("button", { name: /^6:00 PM.*Next Service Guest/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /^6:00 PM.*Private Guest/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Service date")).toHaveValue(tomorrow);
});

it("clears table assignment mode when the service date changes", async () => {
  render(<StaffDesk local />);
  fireEvent.click(await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ }));
  fireEvent.click(screen.getByRole("button", { name: "Choose table on floor" }));
  expect(screen.getByText(/Tap a table for/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next date" }));
  fireEvent.click(await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ }));
  expect(screen.queryByText(/Tap a table for/)).not.toBeInTheDocument();
});

it("shows the selected upcoming party's time on the floor", async () => {
  render(<StaffDesk local />);
  fireEvent.click(await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ }));
  expect(screen.getByLabelText("Floor plan time")).toHaveValue("18:00");
  expect(screen.getByRole("button", { name: /Table 11.*reserved.*Private Guest/ })).toBeVisible();
});

it("starts a walk-in for today even when the host is viewing a future service", async () => {
  render(<StaffDesk local />);
  await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ });
  fireEvent.click(screen.getByRole("button", { name: "Next date" }));
  await screen.findByRole("button", { name: "Walk-in" });
  fireEvent.click(screen.getByRole("button", { name: "Walk-in" }));
  expect(screen.getByLabelText("Date")).toHaveValue(venueNow().date);
  expect(screen.getByLabelText("Date")).toHaveAttribute("readonly");
});

it("runs arrival, seating, a table move and completion through the host controls", async () => {
  render(<StaffDesk local />);
  fireEvent.click(await screen.findByRole("button", { name: /^6:00 PM.*Private Guest/ }));
  fireEvent.click(screen.getByRole("button", { name: "Mark arrived" }));
  await waitFor(() => expect(reservation.status).toBe("arrived"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Seat guest" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Seat guest" }));
  await waitFor(() => expect(reservation.status).toBe("seated"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Move to another table" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Move to another table" }));
  fireEvent.click(screen.getByRole("button", { name: /Table 12, 2 seats/ }));
  await waitFor(() => expect(reservation.tableId).toBe("12"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Finish visit" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Finish visit" }));
  await waitFor(() => expect(reservation.status).toBe("completed"));
  expect(mutations.map(m => m.version)).toEqual([1, 2, 3, 4]);
  expect(screen.queryByRole("button", { name: /^6:00 PM.*Private Guest/ })).not.toBeInTheDocument();
});

it("shows returning guests in the service list and a minimized visit summary in details", async () => {
  visits = 3;
  render(<StaffDesk local />);
  expect(await screen.findByText('Returning · 3 prior visits')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /^6:00 PM.*Private Guest/ }));
  expect(screen.getByText('Returning guest · 3 prior completed visits')).toBeVisible();
  expect(screen.getByText(/Last visit · Thu, Oct 1/)).toBeVisible();
  expect(screen.getByText(/Shared contact details can represent different guests/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Guest book' })).not.toBeInTheDocument();
});
it("does not label guests with no contact details as first-time visitors", async () => {
  reservation.email = '';
  reservation.phone = '';
  render(<StaffDesk local />);
  fireEvent.click(await screen.findByRole('button', { name: /^6:00 PM.*Private Guest/ }));
  expect(screen.getByText('Visit history unavailable')).toBeVisible();
  expect(screen.queryByText('No prior completed visits')).not.toBeInTheDocument();
});
