import { handle, json, staffAccess } from "@/lib/openres/http";
import { supporterContacts, supporterTeams } from "@/lib/openres/service";
import { readReservations, recordAccessAudit } from "@/lib/openres/store";
/**
 * Manager only. Without a team: how many guests are with each team, and how many asked to hear
 * about it. With one: the guests who asked, as JSON or (format=csv) a file for the venue's
 * email tool. Guests who did not ask are counted but never listed.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const access = await staffAccess(request, true);
    if (access instanceof Response) return access;
    const params = new URL(request.url).searchParams;
    const team = (params.get("team") || "").trim().slice(0, 120);
    const records = await readReservations();
    if (!team) return json({ teams: supporterTeams(records) });
    const contacts = supporterContacts(records).filter((c) => c.team === team);
    await recordAccessAudit(access.actor, "supporter_list_export", `records=${contacts.length}`);
    if (params.get("format") !== "csv") return json({ team, contacts });
    const cell = (value: unknown) => {
      let text = String(value ?? "");
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [
      ["Name", "Email", "Team", "Asked for updates", "Last booked", "Completed visits"],
      ...contacts.map((c) => [c.name, c.email, c.team, c.askedAt.slice(0, 10), c.lastBooked, c.visits]),
    ];
    const slug = team.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team";
    return new Response(rows.map((row) => row.map(cell).join(",")).join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="supporters-${slug}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
