import { handle, staffAccess } from "@/lib/openres/http";
import { dateSchema, matchLabel, venueNow } from "@/lib/openres/model";
import { readReservations, recordAccessAudit } from "@/lib/openres/store";
export async function GET(request: Request) {
  return handle(async () => {
    const access = await staffAccess(request, true);
    if (access instanceof Response) return access;
    const date = dateSchema.parse(
      new URL(request.url).searchParams.get("date") || venueNow().date,
    );
    const reservations = await readReservations(date);
    await recordAccessAudit(
      access.actor,
      "reservation_export",
      `${date}; records=${reservations.length}`,
    );
    const cell = (value: unknown) => {
      let text = String(value ?? "");
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [
      [
        "Record ID",
        "Version",
        "Date",
        "Time",
        "Guest",
        "Party",
        "Table",
        "Status",
        "Booking source",
        "Match preference",
        "Match evidence",
      ],
      ...reservations.map((r) => [
        r.id,
        r.version,
        r.date,
        r.time,
        r.name,
        r.partySize,
        r.tableId,
        r.status,
        r.source,
        matchLabel(r.match),
        r.provenance?.match.source || "not recorded",
      ]),
    ];
    return new Response(
      rows.map((row) => row.map(cell).join(",")).join("\r\n"),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="openres-${date}.csv"`,
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  });
}
