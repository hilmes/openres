import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookingWidget } from "./BookingWidget";
import { addDays, venueNow, type BookingFixture } from "@/lib/openres/model";
const date = addDays(venueNow().date, 1);
const fixture: BookingFixture = {
  id: "match-1",
  date,
  time: "18:00",
  home: "Arsenal",
  away: "Chelsea",
  competition: "PL",
};
let submitted: Record<string, unknown> | undefined;
beforeEach(() => {
  submitted = undefined;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes("availability"))
        return {
          ok: true,
          json: async () => ({
            slots: [{ time: "18:00", areas: ["tables"] }],
            enabled: true,
            advanceDays: 30,
            duration: 90,
          }),
        };
      submitted = JSON.parse(String(options?.body));
      return {
        ok: true,
        json: async () => ({
          reservation: { ...submitted, status: "confirmed", duration: 90 },
          token: "local-test-token",
          emailed: false,
        }),
      };
    }),
  );
});
async function book() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Reserve at 6:00 PM" }),
  );
  fireEvent.change(screen.getByLabelText("Full name"), {
    target: { value: "Test Guest" },
  });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "guest@example.com" },
  });
  expect(screen.getByLabelText("Phone (optional)")).not.toBeRequired();
  fireEvent.click(screen.getByRole("button", { name: "Confirm reservation" }));
  await screen.findByText("Your reservation is confirmed");
}
describe("fixture-first reservation flow", () => {
  it("books an ordinary venue without asking for a match", async () => {
    render(<BookingWidget initialDate={date} />);
    expect(screen.getByLabelText("Reservation date")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "OTHER" })).not.toBeInTheDocument();
    expect(screen.queryByText("No match preference")).not.toBeInTheDocument();
    await book();
    expect(submitted?.match).toEqual({ kind: "none" });
  });
  it("starts with fixtures, + Other and Skip before showing booking controls", () => {
    render(<BookingWidget fixtures={[fixture]} />);
    expect(screen.getByRole("button", { name: "OTHER" })).toBeVisible();
    expect(screen.getByRole("button", { name: "SKIP" })).toBeVisible();
    expect(screen.queryByLabelText("Reservation date")).not.toBeInTheDocument();
  });
  it("books a selected fixture and locks the date to the match", async () => {
    render(<BookingWidget fixtures={[fixture]} />);
    fireEvent.click(screen.getByRole("button", { name: /Arsenal vs Chelsea/ }));
    expect(screen.getByLabelText("Reservation date")).toHaveValue(date);
    expect(screen.getByLabelText("Reservation date")).toBeDisabled();
    await book();
    expect(submitted?.match).toEqual({ kind: "fixture", fixture });
    expect(submitted?.date).toBe(date);
    expect(submitted?.phone).toBe("");
    expect(submitted).not.toHaveProperty("occasion");
  });
  it("requires an Other match request and carries it through confirmation", async () => {
    render(<BookingWidget fixtures={[fixture]} initialDate={date} />);
    fireEvent.click(screen.getByRole("button", { name: "OTHER" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByLabelText("Reservation date")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Which match?"), {
      target: { value: "Mexico vs USA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Requested: Mexico vs USA")).toBeVisible();
    await book();
    expect(submitted?.match).toEqual({
      kind: "other",
      request: "Mexico vs USA",
    });
  });
  it("Skip records no match preference and lets guests choose their date", async () => {
    render(<BookingWidget fixtures={[fixture]} initialDate={date} />);
    fireEvent.click(screen.getByRole("button", { name: "SKIP" }));
    expect(screen.getByText("No match preference")).toBeVisible();
    expect(screen.getByLabelText("Reservation date")).toBeEnabled();
    await book();
    expect(submitted?.match).toEqual({ kind: "none" });
  });
  it("a calendar fixture prefill can be changed to no preference", async () => {
    render(<BookingWidget fixtures={[fixture]} initialFixtureId="match-1" />);
    await waitFor(() =>
      expect(screen.getByLabelText("Reservation date")).toHaveValue(date),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "SKIP" }));
    expect(screen.getByText("No match preference")).toBeVisible();
    await screen.findByRole("button", { name: "Reserve at 6:00 PM" });
  });
});
