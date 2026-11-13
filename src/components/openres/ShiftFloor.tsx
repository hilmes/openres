"use client";
import { venue } from "@/config/venue";
import { CalendarDays, Plus, Users } from "lucide-react";
import {
  AREAS,
  TABLES,
  STATUS_LABEL,
  matchLabel,
  timeLabel,
  type Reservation,
  type Settings,
} from "@/lib/openres/model";
import { FloorMap, tableReservationAt } from "./FloorMap";
import styles from "./openres.module.css";
export function ShiftFloor({
  reservations,
  parties,
  settings,
  time,
  selected,
  tableId,
  assigning,
  onTime,
  onTable,
  onGuest,
  onWalkIn,
  onCancelAssignment,
}: {
  reservations: Reservation[];
  parties: Reservation[];
  settings: Settings;
  time: string;
  selected?: Reservation;
  tableId?: string;
  assigning: boolean;
  onTime: (time: string) => void;
  onTable: (id: string) => void;
  onGuest: (id: string) => void;
  onWalkIn: (tableId?: string) => void;
  onCancelAssignment: () => void;
}) {
  const table = TABLES.find((t) => t.id === tableId);
  const current = table && tableReservationAt(reservations, table.id, time);
  return (
    <div className={styles.shiftFloor}>
      <section className={styles.arrivalRail} aria-label="Service guest list">
        <div className={styles.railHeading}>
          <h2>Guest list</h2>
          <span>{parties.length} parties</span>
        </div>
        <div className={styles.railParties}>
          {!parties.length && (
            <p className={styles.empty}>No parties in this view.</p>
          )}
          {parties.map((r) => (
            <button
              key={r.id}
              className={styles.railParty}
              aria-pressed={selected?.id === r.id}
              onClick={() => onGuest(r.id)}
            >
              <span className={styles.railTime}>
                {timeLabel(r.time)}{" "}
                <span>
                  <Users size={13} />
                  {r.partySize}
                </span>
              </span>
              <strong>{r.name}</strong>
              <span className={styles.railMeta}>
                <span className={styles.status} data-status={r.status}>
                  {STATUS_LABEL[r.status]}
                </span>
                <b>{r.tableId ? `T${r.tableId}` : "Unassigned"}</b>
              </span>
              {r.match?.kind !== "none" && <small>{matchLabel(r.match)}</small>}
            </button>
          ))}
        </div>
        <button className={styles.secondaryButton} onClick={() => onWalkIn()}>
          <Plus size={16} /> Walk-in
        </button>
      </section>
      <section className={styles.shiftPlan} aria-label="Table seating">
        <div className={styles.panelHeading}>
          <h2>{venue.name}</h2>
          <label>
            <CalendarDays size={15} />
            <input
              aria-label="Floor plan time"
              type="time"
              step={900}
              value={time}
              onChange={(e) => e.target.value && onTime(e.target.value)}
            />
          </label>
        </div>
        {assigning && selected && (
          <div className={styles.assignPrompt} role="status">
            <span>
              Tap a table for <strong>{selected.name}</strong> ·{" "}
              {selected.partySize} guests
            </span>
            <button onClick={onCancelAssignment}>Cancel</button>
          </div>
        )}
        <FloorMap
          reservations={reservations}
          settings={settings}
          time={time}
          selected={tableId || selected?.tableId || undefined}
          assigning={assigning}
          onSelect={onTable}
        />
        <div className={styles.legend}>
          <span data-state="free">Available</span>
          <span data-state="reserved">Reserved</span>
          <span data-state="arrived">Arrived</span>
          <span data-state="seated">Seated</span>
          <span data-state="disabled">Offline</span>
        </div>
        {table && !assigning && (
          <div className={styles.tableStrip}>
            <div>
              <strong>Table {table.id}</strong>
              <span>
                {table.seats} seats · {AREAS[table.area]}
                {current ? ` · ${STATUS_LABEL[current.status]}` : ""}
              </span>
            </div>
            {!current && !settings.disabledTables.includes(table.id) && (
              <button
                className={styles.primaryButton}
                onClick={() => onWalkIn(table.id)}
              >
                Seat a walk-in
              </button>
            )}
          </div>
        )}
        <details className={styles.planProvenance}>
          <summary>Floor source &amp; seating data</summary>
          <p>{venue.floor.label} · {venue.floor.revision}</p>
          <p>Table geometry comes from the venue configuration. Colors show OpenRes bookings and staff seating actions.</p>
        </details>
      </section>
    </div>
  );
}
