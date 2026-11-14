"use client";
import { venue } from '@/config/venue';
import { useState, type FormEvent } from "react";
import {
  AREAS,
  TABLES,
  timeString,
  type Settings,
} from "@/lib/openres/model";
import { api, ErrorMessage } from "./shared";
import { usePaths } from "./paths";
import styles from "./openres.module.css";
export function SettingsPanel({
  initial,
  onSaved,
}: {
  initial: Settings;
  onSaved: () => void;
}) {
  const paths = usePaths();
  const [settings, setSettings] = useState(() => structuredClone(initial));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [purge, setPurge] = useState("");
  // Run the retention pass against the saved period, never an unsaved edit.
  const savedRetention = initial.retentionDays ?? null;
  async function purgeNow() {
    setBusy(true);
    setError("");
    setPurge("");
    try {
      const result = await api<{ removed: number; more: boolean }>(`${paths.api}/retention`, { method: "POST", body: JSON.stringify({ action: "purge" }) });
      setPurge(result.removed
        ? `Removed guest details from ${result.removed} past ${result.removed === 1 ? "reservation" : "reservations"}.${result.more ? " More remain; run it again." : ""}`
        : "Nothing is past the retention period.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function change(patch: Partial<Settings>) {
    setSettings((s) => ({ ...s, ...patch }));
    setSaved(false);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ settings: Settings }>(
        `${paths.api}/settings`,
        { method: "PUT", body: JSON.stringify(settings) },
      );
      setSettings(data.settings);
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={styles.settings} onSubmit={submit}>
      <div className={styles.panelHeading}>
        <div>
          <span className={styles.eyebrow}>THE HOUSE RULES</span>
          <h2>Booking settings</h2>
        </div>
        <button disabled={busy} className={styles.primaryButton}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
      <ErrorMessage error={error} />
      {saved && (
        <p role="status" className={styles.success}>
          Settings saved.
        </p>
      )}
      <section>
        <h3>Online reservations</h3>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => change({ enabled: e.target.checked })}
          />{" "}
          Accept reservations on OpenRes
        </label>
        <p className={styles.finePrint}>
          Before enabling online reservations, make sure these tables are not
          simultaneously bookable in another system. External reservations
          are not imported automatically.
        </p>
        <div className={styles.formGrid}>
          <label>
            Table time (minutes)
            <input
              type="number"
              min={45}
              max={240}
              step={15}
              value={settings.duration}
              onChange={(e) => change({ duration: Number(e.target.value) })}
              required
            />
          </label>
          <label>
            Book ahead (days)
            <input
              type="number"
              min={1}
              max={90}
              value={settings.advanceDays}
              onChange={(e) => change({ advanceDays: Number(e.target.value) })}
              required
            />
          </label>
          <label>
            Minimum notice (minutes)
            <input
              type="number"
              min={0}
              max={1440}
              value={settings.leadMinutes}
              onChange={(e) => change({ leadMinutes: Number(e.target.value) })}
              required
            />
          </label>
        </div>
      </section>
      <section>
        <h3>Bookable service hours</h3>
        <p className={styles.finePrint}>
          {venue.timeZone}. The last reservation must finish before closing. These
          are booking windows, separate from public opening hours.
        </p>
        {settings.hours.map((h, i) => (
          <div className={styles.hoursRow} key={i}>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={!h.closed}
                onChange={(e) =>
                  change({
                    hours: settings.hours.map((item, j) =>
                      j === i ? { ...item, closed: !e.target.checked } : item,
                    ),
                  })
                }
              />
              {
                [
                  "Sunday",
                  "Monday",
                  "Tuesday",
                  "Wednesday",
                  "Thursday",
                  "Friday",
                  "Saturday",
                ][i]
              }
            </label>
            <select
              aria-label={`${i} opening time`}
              disabled={h.closed}
              value={h.open}
              onChange={(e) =>
                change({
                  hours: settings.hours.map((item, j) =>
                    j === i ? { ...item, open: Number(e.target.value) } : item,
                  ),
                })
              }
            >
              {Array.from({ length: 48 }, (_, j) => (
                <option key={j} value={j * 30}>
                  {timeString(j * 30)}
                </option>
              ))}
            </select>
            <span>to</span>
            <select
              aria-label={`${i} closing time`}
              disabled={h.closed}
              value={h.close}
              onChange={(e) =>
                change({
                  hours: settings.hours.map((item, j) =>
                    j === i ? { ...item, close: Number(e.target.value) } : item,
                  ),
                })
              }
            >
              {Array.from({ length: 48 }, (_, j) => (
                <option key={j} value={(j + 1) * 30}>
                  {j === 47 ? "Midnight" : timeString((j + 1) * 30)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </section>
      <section>
        <h3>Tables available to book</h3>
        <p className={styles.finePrint}>
          Uncheck tables to take them offline. Existing reservations keep their
          assigned tables.
        </p>
        <div className={styles.tableToggles}>
          {TABLES.map((t) => (
            <label key={t.id} className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={!settings.disabledTables.includes(t.id)}
                onChange={(e) =>
                  change({
                    disabledTables: e.target.checked
                      ? settings.disabledTables.filter((id) => id !== t.id)
                      : [...settings.disabledTables, t.id],
                  })
                }
              />
              <span>
                Table {t.id}
                <small>
                  {AREAS[t.area]} · {t.seats} seats
                </small>
              </span>
            </label>
          ))}
        </div>
      </section>
      <section>
        <h3>Guest details</h3>
        <label>
          Keep guest details after a visit
          <select
            value={settings.retentionDays ?? ""}
            onChange={(e) => change({ retentionDays: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Until a manager removes them</option>
            {[30, 90, 180, 365, 730, 1095].map((days) => (
              <option key={days} value={days}>
                {days < 365 ? `${days} days` : `${days / 365} ${days === 365 ? "year" : "years"}`}
              </option>
            ))}
          </select>
        </label>
        <p className={styles.finePrint}>
          After this, name, email, phone, notes and typed match requests are removed from completed,
          cancelled and no-show reservations. The date, time, party size, table and status stay for
          reporting. This runs once a day. It cannot be undone, and it does not reach database
          backups or email already delivered.
        </p>
        <button type="button" className={styles.secondaryButton} disabled={busy || !savedRetention} onClick={purgeNow}>
          Remove expired details now
        </button>
        {!savedRetention && <p className={styles.finePrint}>Choose a period and save to enable removal.</p>}
        {purge && <p role="status" className={styles.success}>{purge}</p>}
      </section>
      <section>
        <h3>Closed dates</h3>
        <label>
          One date per line (YYYY-MM-DD)
          <textarea
            rows={4}
            value={settings.closedDates.join("\n")}
            onChange={(e) =>
              change({
                closedDates: e.target.value.split("\n").filter(Boolean),
              })
            }
            placeholder="2026-12-25"
          />
        </label>
      </section>
    </form>
  );
}
