import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SupporterPanel, SupporterTally } from "./Supporters";
import type { Reservation } from "@/lib/openres/model";

afterEach(() => vi.unstubAllGlobals());
const fixture = { id: "match-1", date: "2026-11-21", time: "18:00", home: "Arsenal", away: "Chelsea", competition: "PL" };
const party = (partySize: number, side?: "home" | "away", status = "confirmed") =>
  ({ partySize, status, match: { kind: "fixture", fixture, ...(side ? { side } : {}) } }) as Reservation;

it("counts the guests booked for each side of a fixture, leaving out cancelled parties", () => {
  render(<SupporterTally reservations={[party(4, "home"), party(2, "home"), party(3, "away"), party(5), party(8, "away", "cancelled")]} />);
  const row = screen.getByRole("listitem");
  expect(row).toHaveTextContent("Arsenal 6");
  expect(row).toHaveTextContent("Chelsea 3");
  expect(row).toHaveTextContent("Neutral 5");
});

it("shows nothing when no party booked a fixture", () => {
  const { container } = render(<SupporterTally reservations={[{ partySize: 2, status: "confirmed", match: { kind: "none" } } as Reservation]} />);
  expect(container).toBeEmptyDOMElement();
});

it("filters the guest book by team and offers a download only where someone asked for updates", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ teams: [{ team: "Arsenal", guests: 3, contactable: 1 }, { team: "Real Sociedad", guests: 1, contactable: 0 }] }) })));
  const onFilter = vi.fn();
  render(<SupporterPanel filter={null} onFilter={onFilter} />);
  fireEvent.click(await screen.findByRole("button", { name: /Arsenal/ }));
  expect(onFilter).toHaveBeenCalledWith("Arsenal");
  expect(screen.getByText("3 guests · 1 asked for updates")).toBeVisible();
  expect(screen.getByText("1 guest · 0 asked for updates")).toBeVisible();
  expect(screen.getByRole("link", { name: "Download the Arsenal supporter list" })).toHaveAttribute("href", "/api/openres/supporters?team=Arsenal&format=csv");
  expect(screen.queryByRole("link", { name: /Real Sociedad/ })).toBeNull();
});
