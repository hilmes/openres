import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MatchPicker } from "./MatchPicker";
import { Brand } from "./shared";
import { OpenResPathsProvider } from "./paths";

afterEach(() => vi.unstubAllGlobals());
function stubFetch() {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ fixtures: [] }) }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("uses the standalone routes without a provider", async () => {
  const fetch = stubFetch();
  render(<><Brand /><MatchPicker onSelect={() => {}} /></>);
  expect(screen.getByLabelText("OpenRes home").getAttribute("href")).toBe("/book");
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/openres/fixtures", expect.anything()));
});

it("sends a host site's components to its own routes and API base", async () => {
  const fetch = stubFetch();
  render(
    <OpenResPathsProvider paths={{ api: "/api/openres/demo", book: "/schedule/book" }}>
      <Brand />
      <MatchPicker onSelect={() => {}} />
    </OpenResPathsProvider>,
  );
  expect(screen.getByLabelText("OpenRes home").getAttribute("href")).toBe("/schedule/book");
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/openres/demo/fixtures", expect.anything()));
  expect(fetch).not.toHaveBeenCalledWith("/api/openres/fixtures", expect.anything());
});
