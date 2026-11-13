"use client";
import { venue } from "@/config/venue";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarDays, Check, MapPin } from "lucide-react";
import {
  addDays,
  dateLabel,
  editedMatchPreference,
  matchLabel,
  matchRequestValue,
  STATUS_LABEL,
  timeLabel,
  venueNow,
  type GuestReservation,
} from "@/lib/openres/model";
import { api, Brand, downloadCalendar, ErrorMessage, Modal } from "./shared";
import styles from "./openres.module.css";

export function ManagePage() {
  const [key, setKey] = useState({ id: "", token: "" });
  const [reservation, setReservation] = useState<GuestReservation | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"edit" | "cancel" | null>(null);
  useEffect(() => {
    const [id, token] = window.location.hash.slice(1).split(".");
    if (!id || !token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The private URL fragment is only available after the browser mounts.
      setError(
        "Open the complete private link from your reservation confirmation.",
      );
      setLoading(false);
      return;
    }
    setKey({ id, token });
    const controller = new AbortController();
    api<{ reservation: GuestReservation }>(
      `/api/openres/reservations/${id}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    )
      .then((data) => setReservation(data.reservation))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  async function update(changes: Record<string, unknown>) {
    if (!reservation || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await api<{
        reservation: GuestReservation;
        emailed: boolean;
      }>(`/api/openres/reservations/${key.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${key.token}` },
        body: JSON.stringify({ ...changes, version: reservation.version }),
      });
      setReservation(data.reservation);
      setDialog(null);
      setNotice(
        data.emailed
          ? "Your reservation is updated. We’ve emailed the details."
          : "Your reservation is updated. Email was not sent; keep this link for your records.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function edit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void update({
      date: form.get("date"),
      time: form.get("time"),
      partySize: Number(form.get("partySize")),
      notes: form.get("notes"),
      match: form.has("match") ? editedMatchPreference(
        reservation?.match,
        String(form.get("match") || ""),
      ) : reservation?.match,
    });
  }
  return (
    <div className={styles.guest} data-openres-private>
      <header className={styles.guestHeader}>
        <Brand />
        <a href="/book">
          <ArrowLeft size={16} /> Back to {venue.name}
        </a>
      </header>
      <main className={styles.manage}>
        <span className={styles.eyebrow}>YOUR RESERVATION</span>
        <h1>Your reservation</h1>
        <ErrorMessage error={dialog ? "" : error} />
        {loading && <p>Finding your reservation…</p>}
        {reservation && (
          <div className={styles.manageCard}>
            <span className={styles.status} data-status={reservation.status}>
              {STATUS_LABEL[reservation.status]}
            </span>
            <h2>{reservation.name}</h2>
            <p className={styles.manageDate}>
              {dateLabel(reservation.date)}
              <br />
              {timeLabel(reservation.time)} · {reservation.partySize} guests
            </p>
            {(venue.features.fixtures || reservation.match?.kind !== "none") && <p>{matchLabel(reservation.match)}</p>}
            <p>{venue.timeZone} · {reservation.duration} minute visit</p>
            <p>
              <MapPin size={16} /> {venue.address}
            </p>
            {reservation.status === "waitlisted" && (
              <p className={styles.error}>
                You’re on the waitlist. A table is not yet confirmed.
              </p>
            )}
            {reservation.notes && (
              <div className={styles.guestNote}>
                <strong>Your notes</strong>
                <p>{reservation.notes}</p>
              </div>
            )}
            <div className={styles.actions}>
              {["confirmed", "waitlisted"].includes(reservation.status) && (
                <>
                  <button
                    className={styles.primaryButton}
                    onClick={() => {
                      setError("");
                      setDialog("edit");
                    }}
                  >
                    Change reservation
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => {
                      setError("");
                      setDialog("cancel");
                    }}
                  >
                    Cancel reservation
                  </button>
                </>
              )}
              {["confirmed", "arrived"].includes(reservation.status) && (
                <button
                  className={styles.textButton}
                  onClick={() => downloadCalendar(reservation)}
                >
                  <CalendarDays size={16} /> Add to calendar
                </button>
              )}
            </div>
            <p className={styles.finePrint}>
              Keep this link private. Anyone with it can manage this
              reservation.
              <br />
              Need a hand?{" "}
              <a href={`mailto:${venue.contactEmail}`}>{venue.contactEmail}</a>
            </p>
          </div>
        )}
        {notice && (
          <p className={styles.success} role="status">
            <Check size={16} />
            {notice}
          </p>
        )}
        {dialog && reservation && (
          <Modal
            busy={busy}
            title={
              dialog === "edit"
                ? "Change your reservation"
                : "Cancel your reservation?"
            }
            onClose={() => {
              if (!busy) setDialog(null);
            }}
          >
            <ErrorMessage error={error} />
            {dialog === "cancel" ? (
              <div className={styles.bookingForm}>
                <p>
                  Your table for {reservation.partySize} on{" "}
                  {dateLabel(reservation.date)} at {timeLabel(reservation.time)}{" "}
                  will be released.
                </p>
                <button
                  disabled={busy}
                  className={styles.dangerButton}
                  onClick={() => update({ status: "cancelled" })}
                >
                  {busy ? "Cancelling…" : "Yes, cancel reservation"}
                </button>
                <button
                  className={styles.secondaryButton}
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  Keep my reservation
                </button>
              </div>
            ) : (
              <form onSubmit={edit} className={styles.bookingForm}>
                <p>
                  We’ll check availability before saving. Your existing table
                  stays reserved if the new time isn’t available.
                </p>
                <div className={styles.formGrid}>
                  <label>
                    Date
                    <input
                      name="date"
                      type="date"
                      defaultValue={reservation.date}
                      min={venueNow().date}
                      max={addDays(venueNow().date, 90)}
                      required
                    />
                  </label>
                  <label>
                    Time
                    <input
                      name="time"
                      type="time"
                      step={900}
                      defaultValue={reservation.time}
                      required
                    />
                  </label>
                </div>
                <label>
                  Guests
                  <select name="partySize" defaultValue={reservation.partySize}>
                    {Array.from({ length: 8 }, (_, i) => (
                      <option key={i} value={i + 1}>
                        {i + 1} guests
                      </option>
                    ))}
                  </select>
                </label>
                {(venue.features.fixtures || reservation.match?.kind !== "none") && <label>
                  Match preference (blank = no preference)
                  <input
                    name="match"
                    defaultValue={matchRequestValue(reservation.match)}
                    maxLength={240}
                  />
                </label>}
                <label>
                  Your notes
                  <textarea
                    name="notes"
                    maxLength={1000}
                    rows={3}
                    defaultValue={reservation.notes}
                  />
                </label>
                <button className={styles.primaryButton} disabled={busy}>
                  {busy ? "Checking your table…" : "Save changes"}
                </button>
              </form>
            )}
          </Modal>
        )}
      </main>
    </div>
  );
}
