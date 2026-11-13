"use client";
import { venue } from "@/config/venue";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  LayoutGrid,
  LockKeyhole,
  List,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Users,
  X,
} from "lucide-react";
import {
  addDays,
  AREAS,
  dateLabel,
  DEFAULT_SETTINGS,
  editedMatchPreference,
  matchLabel,
  matchRequestValue,
  minutes,
  STATUS_LABEL,
  TABLES,
  timeLabel,
  timeString,
  TRANSITIONS,
  venueNow,
  type Reservation,
  type Settings,
  type Status,
  type VisitHistory,
  type VisitSummary,
} from "@/lib/openres/model";
import { api, ErrorMessage, Modal, PreviewBanner } from "./shared";
import { tableReservationAt } from "./FloorMap";
import { ShiftFloor } from "./ShiftFloor";
import { SettingsPanel } from "./SettingsPanel";
import styles from "./openres.module.css";

type DeskData = {
  reservations: Reservation[];
  visits?: VisitHistory[];
  visitSummaries?: Record<string, VisitSummary>;
  settings: Settings;
  manager: boolean;
  local: boolean;
};
type Tab = "reservations" | "waitlist" | "guests" | "settings";
type View = "list" | "floor" | "timeline";
function NewReservation({
  date,
  waitlist,
  onClose,
  onSaved,
  initialSource = "phone",
  tableId,
}: {
  date: string;
  waitlist: boolean;
  onClose: () => void;
  onSaved: (reservation: Reservation) => void;
  initialSource?: "phone" | "walk_in";
  tableId?: string;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [source, setSource] = useState<string>(initialSource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clock = venueNow();
  const next = Math.min(1425, Math.ceil(clock.minutes / 15) * 15);
  const seatNow = source === "walk_in" && !waitlist;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      const current = venueNow();
      const result = await api<{ reservation: Reservation }>("/api/openres/desk", {
        method: "POST",
        body: JSON.stringify({
          id,
          name: form.get("name"),
          email: form.get("email"),
          phone: form.get("phone"),
          date: seatNow ? current.date : form.get("date"),
          time: seatNow ? timeString(Math.floor(current.minutes / 15) * 15) : form.get("time"),
          partySize: Number(form.get("partySize")),
          area: form.get("area"),
          notes: form.get("notes"),
          match: editedMatchPreference(
            undefined,
            String(form.get("match") || ""),
          ),
          source,
          tableId,
          waitlist,
        }),
      });
      onSaved(result.reservation);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={waitlist ? "Add to waitlist" : seatNow ? "Seat a walk-in" : "Add a reservation"}
      busy={busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className={styles.bookingForm} onSubmit={submit}>
        {tableId && (
          <p className={styles.assignPrompt}>
            Table {tableId} · {TABLES.find((t) => t.id === tableId)?.seats}{" "}
            seats
          </p>
        )}
        <ErrorMessage error={error} />
        <div className={styles.formGrid}>
          <label>
            Guest name
            <input
              name="name"
              required
              minLength={2}
              maxLength={100}
              autoComplete="off"
              placeholder="First and last name"
            />
          </label>
          <label>
            Party size
            <select name="partySize" defaultValue="2">
              {Array.from({ length: 8 }, (_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1} guests
                </option>
              ))}
            </select>
          </label>
          <label>
            Date
            <input key={seatNow ? "now" : "planned"} name="date" type="date" defaultValue={seatNow ? clock.date : date} readOnly={seatNow} required />
          </label>
          <label>
            Time ({venue.timeZone})
            <input
              name="time"
              type="time"
              key={seatNow ? "now" : "planned"}
              step={seatNow ? 60 : 900}
              readOnly={seatNow}
              defaultValue={seatNow ? timeString(clock.minutes) : date === clock.date ? timeString(next) : "18:00"}
              required
            />
          </label>
          <label>
            Email (optional)
            <input name="email" type="email" maxLength={254} />
          </label>
          <label>
            Phone (optional)
            <input name="phone" type="tel" maxLength={32} />
          </label>
          <label>
            Seating area
            <select name="area">
              <option value="any">Best available</option>
              {Object.entries(AREAS).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="phone">Phone / staff</option>
              <option value="walk_in">Walk-in · seat now</option>
            </select>
          </label>
        </div>
        {venue.features.fixtures && <label>
          Requested match (leave blank for no preference)
          <input name="match" maxLength={240} />
        </label>}
        <label>
          Guest notes
          <textarea
            name="notes"
            rows={3}
            maxLength={1000}
            placeholder="Dietary needs, occasion, seating requests…"
          />
        </label>
        <p className={styles.finePrint}>
          {waitlist
            ? "No table is held until this guest is confirmed or seated."
            : "A suitable table is assigned automatically. Walk-ins are seated immediately."}{" "}
          A confirmation email is sent when an email address is supplied and
          delivery is configured.
        </p>
        <button disabled={busy} className={styles.primaryButton}>
          {busy ? "Saving…" : waitlist ? "Add to waitlist" : "Add reservation"}
        </button>
      </form>
    </Modal>
  );
}
function ReservationEditor({
  reservation: r,
  busy,
  error,
  onSave,
  onClose,
}: {
  reservation: Reservation;
  busy: boolean;
  error: string;
  onSave: (changes: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  return (
    <Modal title={`Edit ${r.name}`} busy={busy} onClose={onClose}>
      <form
        className={styles.bookingForm}
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const success = await onSave({
            date: form.get("date"),
            time: form.get("time"),
            partySize: Number(form.get("partySize")),
            area: form.get("area"),
            notes: form.get("notes"),
            staffNotes: form.get("staffNotes"),
            match: form.has("match") ? editedMatchPreference(
              r.match,
              String(form.get("match") || ""),
            ) : r.match,
          });
          if (success) onClose();
        }}
      >
        <ErrorMessage error={error} />
        <div className={styles.formGrid}>
          <label>
            Date
            <input name="date" type="date" defaultValue={r.date} required />
          </label>
          <label>
            Time
            <input
              name="time"
              type="time"
              step={900}
              defaultValue={r.time}
              required
            />
          </label>
          <label>
            Guests
            <input
              name="partySize"
              type="number"
              min={1}
              max={8}
              defaultValue={r.partySize}
              required
            />
          </label>
          <label>
            Area
            <select name="area" defaultValue={r.area}>
              <option value="any">Any</option>
              {Object.entries(AREAS).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(venue.features.fixtures || r.match?.kind !== "none") && <label>
          Match preference (blank = no preference)
          <input
            name="match"
            defaultValue={matchRequestValue(r.match)}
            maxLength={240}
          />
        </label>}
        <label>
          Guest notes
          <textarea name="notes" defaultValue={r.notes} maxLength={1000} />
        </label>
        <label>
          Staff notes · private
          <textarea
            name="staffNotes"
            defaultValue={r.staffNotes}
            maxLength={2000}
          />
        </label>
        <button disabled={busy} className={styles.primaryButton}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </form>
    </Modal>
  );
}
export function StaffDesk({ local = false }: { local?: boolean }) {
  const [date, setDate] = useState(() => venueNow().date);
  const [tab, setTab] = useState<Tab>("reservations");
  const [view, setView] = useState<View>("floor");
  const [data, setData] = useState<DeskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newSource, setNewSource] = useState<"phone" | "walk_in">("phone");
  const [newTable, setNewTable] = useState<string | undefined>();
  const [assigning, setAssigning] = useState(false);
  const [privacyPaused, setPrivacyPaused] = useState(false);
  const hidden = useRef(false);
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [guest, setGuest] = useState<string | null>(null);
  const [floorTime, setFloorTime] = useState(() =>
    timeString(Math.floor(venueNow().minutes / 15) * 15),
  );
  const [tableFilter, setTableFilter] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Status | null>(null);
  const generation = useRef(0);
  const serviceGeneration = useRef(0);
  function resetServiceSelection() {
    serviceGeneration.current++;
    generation.current++;
    setSelectedId(null);
    setTableFilter(null);
    setAssigning(false);
    setConfirmation(null);
    setEditOpen(false);
    setNewOpen(false);
    setGuest(null);
    setSearch("");
    setError("");
    setNotice("");
  }
  function changeDate(nextDate: string) {
    if (nextDate === date) return;
    resetServiceSelection();
    setDate(nextDate);
  }
  function changeTab(nextTab: Tab) {
    if (nextTab === tab) return;
    resetServiceSelection();
    setTab(nextTab);
  }
  const load = useCallback(
    async (quiet = false) => {
      if (hidden.current) return;
      const current = ++generation.current;
      if (!quiet) setLoading(true);
      try {
        const result = await api<DeskData>(
          `/api/openres/desk?date=${date}${tab === "guests" ? "&view=guests" : ""}`,
        );
        if (
          current === generation.current &&
          !hidden.current &&
          document.visibilityState !== "hidden"
        ) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (current === generation.current) {
          setError((e as Error).message);
          if (
            (e as { status?: number }).status === 401 ||
            (e as { status?: number }).status === 403
          ) {
            setData(null);
            setSelectedId(null);
            setGuest(null);
          }
        }
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [date, tab],
  );
  useEffect(() => {
    const requestGeneration = generation;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Remove previous-service guest data before the new service fetch starts.
    setData(null);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && tab !== "guests")
        void load(true);
    }, 15000);
    return () => {
      clearInterval(timer);
      requestGeneration.current++;
    };
  }, [load, tab]);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== "hidden") return;
      hidden.current = true;
      generation.current++;
      setData(null);
      setSelectedId(null);
      setGuest(null);
      setSearch("");
      setNewOpen(false);
      setEditOpen(false);
      setPrivacyPaused(true);
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  async function lockDesk() {
    hidden.current = true;
    generation.current++;
    setData(null);
    setSelectedId(null);
    setGuest(null);
    setSearch("");
    setPrivacyPaused(true);
    setError("");
    try {
      await api("/api/openres/lock", { method: "POST", body: "{}" });
    } catch {
      setError(
        "Guest details are hidden. The server could not confirm the lock; close this tab if leaving the device.",
      );
    }
  }
  function startWalkIn(tableId?: string) {
    setNewSource("walk_in");
    setNewTable(tableId);
    setNewOpen(true);
  }
  const reservations = data?.reservations || [];
  const settings = data?.settings || DEFAULT_SETTINGS;
  const selected = reservations.find((r) => r.id === selectedId);
  const selectedVisits = selected ? data?.visitSummaries?.[selected.id] : undefined;
  const active = reservations.filter((r) =>
    ["confirmed", "arrived", "seated"].includes(r.status),
  );
  const filtered = reservations
    .filter(
      (r) =>
        (tab === "waitlist"
          ? r.status === "waitlisted"
          : status === "active"
            ? ["confirmed", "arrived", "seated"].includes(r.status)
            : status === "all"
              ? r.status !== "waitlisted"
              : r.status === status) &&
        (view === "floor" || !tableFilter || r.tableId === tableFilter) &&
        `${r.name} ${r.email} ${r.phone}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      tab === "waitlist"
        ? a.createdAt.localeCompare(b.createdAt)
        : a.time.localeCompare(b.time),
    );
  const guests = useMemo(() => {
    const groups = new Map<string, VisitHistory[]>();
    (data?.visits || []).forEach((r) => {
      const key = r.guestKey;
      groups.set(key, [...(groups.get(key) || []), r]);
    });
    return [...groups.entries()]
      .filter(([, records]) =>
        records[0].name.toLowerCase().includes(search.toLowerCase()),
      )
      .sort((a, b) => a[1][0].name.localeCompare(b[1][0].name));
  }, [data, search]);
  async function update(changes: Record<string, unknown>) {
    if (!selected || busy) return false;
    const service = serviceGeneration.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ reservation: Reservation; emailed: boolean }>(
        "/api/openres/desk",
        {
          method: "PATCH",
          body: JSON.stringify({
            id: selected.id,
            version: selected.version,
            ...changes,
          }),
        },
      );
      if (service !== serviceGeneration.current || hidden.current || document.visibilityState === "hidden") return true;
      setData((d) =>
        d
          ? {
              ...d,
              reservations: d.reservations.map((r) =>
                r.id === result.reservation.id ? result.reservation : r,
              ),
            }
          : d,
      );
      setNotice("Reservation updated.");
      setConfirmation(null);
      setAssigning(false);
      await load(true);
      return true;
    } catch (e) {
      if (service === serviceGeneration.current && !hidden.current) setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function selectGuest(id: string) {
    const party = reservations.find((r) => r.id === id);
    setSelectedId(id);
    setTableFilter(party?.tableId || null);
    setAssigning(false);
    setConfirmation(null);
    if (party) setFloorTime(party.status === "seated" ? timeString(venueNow().minutes) : party.time);
  }
  async function selectTable(id: string) {
    setTableFilter(id);
    if (assigning && selected) {
      await update({
        tableId: id,
        ...(selected.status === "waitlisted" ? { status: "seated" } : {}),
      });
      return;
    }
    setSelectedId(tableReservationAt(reservations, id, floorTime)?.id || null);
  }
  const tabs: { id: Tab; label: string; icon: typeof CalendarDays }[] = [
    { id: "reservations", label: "Reservations", icon: CalendarDays },
    { id: "waitlist", label: "Waitlist", icon: Clock3 },
    ...(data?.manager
      ? [{ id: "guests" as Tab, label: "Guest book", icon: Users }]
      : []),
    ...(data?.manager
      ? [{ id: "settings" as Tab, label: "Settings", icon: Settings2 }]
      : []),
  ];
  if (privacyPaused)
    return (
      <main
        className={`${styles.desk} ${styles.privacyCurtain}`}
        data-openres-private
      >
        <LockKeyhole size={28} />
        <h1>Guest details hidden</h1>
        <p>
          {local
            ? "Local preview"
            : "Open the desk to check your staff access again."}
        </p>
        <ErrorMessage error={error} />
        <button
          className={styles.primaryButton}
          onClick={() => window.location.reload()}
        >
          Open desk
        </button>
      </main>
    );
  return (
    <div className={styles.desk} data-openres-private>
      <PreviewBanner local={local} />
      <header className={styles.leanHeader}>
        <a href="/staff" className={styles.leanBrand}>
          OpenRes <span>{venue.name}</span>
        </a>
        <nav aria-label="Reservation desk">
          {tabs.map((t) => (
            <button
              key={t.id}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => changeTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button className={styles.lockDesk} onClick={lockDesk}>
          <LockKeyhole size={16} /> Lock desk
        </button>
        <a href="/book" target="_blank" rel="noreferrer">
          Guest booking ↗
        </a>
      </header>
      <div className={styles.leanShell}>
        <main className={styles.deskMain}>
          <div className={styles.deskTitle}>
            <h1>
              {tab === "reservations"
                ? "Reservations"
                : tab === "waitlist"
                  ? "Waitlist"
                  : tab === "guests"
                    ? "Guests"
                    : "Settings"}
            </h1>
            {tab !== "settings" && tab !== "guests" && (
              <button
                className={styles.primaryButton}
                onClick={() => {
                  setNewSource("phone");
                  setNewTable(undefined);
                  setNewOpen(true);
                }}
                disabled={!data}
              >
                <Plus size={17} />
                {tab === "waitlist" ? "Add guest" : "Add reservation"}
              </button>
            )}
          </div>
          <ErrorMessage error={error} />
          {notice && (
            <p className={styles.inlineNotice} role="status">
              <Check size={14} />
              {notice}
              <button
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                <X size={14} />
              </button>
            </p>
          )}
          {tab !== "settings" && (
            <>
              <div className={styles.toolbar}>
                {tab !== "guests" && (
                  <div className={styles.dateControl}>
                    <button
                      aria-label="Previous date"
                      onClick={() => {
                        changeDate(addDays(date, -1));
                      }}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <label>
                      <CalendarDays size={16} />
                      <input
                        aria-label="Service date"
                        type="date"
                        value={date}
                        onChange={(e) => {
                          if (e.target.value) {
                            changeDate(e.target.value);
                          }
                        }}
                      />
                    </label>
                    <button
                      aria-label="Next date"
                      onClick={() => {
                        changeDate(addDays(date, 1));
                      }}
                    >
                      <ChevronRight size={16} />
                    </button>
                    <button onClick={() => changeDate(venueNow().date)}>
                      Today
                    </button>
                  </div>
                )}
                <label className={styles.search}>
                  <Search size={16} />
                  <input
                    aria-label="Search guests"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={
                      tab === "guests"
                        ? "Search guest name"
                        : "Search name, email, phone"
                    }
                  />
                </label>
                <button
                  className={styles.iconButton}
                  onClick={() => load()}
                  aria-label="Refresh reservations"
                  disabled={loading}
                >
                  <RefreshCw
                    size={17}
                    className={loading ? styles.spinning : ""}
                  />
                </button>
              </div>
              {tab !== "guests" && (
                <div className={styles.leanStats}>
                  <div>
                    <span>Covers</span>
                    <strong>
                      {active.reduce((n, r) => n + r.partySize, 0)}
                    </strong>
                  </div>
                  <div>
                    <span>Seated</span>
                    <strong>
                      {reservations
                        .filter((r) => r.status === "seated")
                        .reduce((n, r) => n + r.partySize, 0)}
                    </strong>
                  </div>
                  <div>
                    <span>Arriving</span>
                    <strong>
                      {
                        reservations.filter((r) =>
                          ["confirmed", "arrived"].includes(r.status),
                        ).length
                      }
                    </strong>
                  </div>
                  <div>
                    <span>Waiting</span>
                    <strong>
                      {
                        reservations.filter((r) => r.status === "waitlisted")
                          .length
                      }
                    </strong>
                  </div>
                </div>
              )}
              {tab === "guests" ? (
                <div className={styles.guestBook}>
                  {loading ? (
                    <p className={styles.empty}>Loading guest history…</p>
                  ) : guests.length === 0 ? (
                    <p className={styles.empty}>No guests match this search.</p>
                  ) : (
                    guests.map(([key, records]) => (
                      <button
                        key={key}
                        className={styles.guestRow}
                        onClick={() => setGuest(key)}
                      >
                        <span className={styles.avatar}>
                          {records[0].name
                            .split(" ")
                            .map((n) => n[0])
                            .slice(0, 2)
                            .join("")}
                        </span>
                        <span>
                          <strong>{records[0].name}</strong>
                          <small>Venue visit history</small>
                        </span>
                        <span>
                          {
                            records.filter((r) => r.status === "completed")
                              .length
                          }{" "}
                          visits<small>{records.length} reservations</small>
                        </span>
                        <span>
                          Last booked<small>{dateLabel(records[0].date)}</small>
                        </span>
                        <ChevronRight size={16} />
                      </button>
                    ))
                  )}
                </div>
              ) : (
                <>
                  <div className={styles.viewToolbar}>
                    <div className={styles.segmented}>
                      {(
                        [
                          { id: "list", icon: List, label: "List" },
                          {
                            id: "floor",
                            icon: LayoutGrid,
                            label: "Floor plan",
                          },
                          { id: "timeline", icon: Clock3, label: "Timeline" },
                        ] as const
                      ).map((v) => (
                        <button
                          key={v.id}
                          aria-pressed={view === v.id}
                          onClick={() => setView(v.id)}
                        >
                          <v.icon size={15} />
                          {v.label}
                        </button>
                      ))}
                    </div>
                    <div className={styles.filterActions}>
                      {tab !== "waitlist" && (
                        <select
                          aria-label="Filter reservation status"
                          value={status}
                          onChange={(e) => setStatus(e.target.value)}
                        >
                          <option value="active">Active reservations</option>
                          <option value="all">All reservations</option>
                          {(
                            [
                              "confirmed",
                              "arrived",
                              "seated",
                              "completed",
                              "cancelled",
                              "no_show",
                            ] as const
                          ).map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      )}
                      {data?.manager && (
                        <a
                          className={styles.iconButton}
                          href={`/api/openres/export?date=${date}`}
                          aria-label="Download manager reservation export"
                        >
                          <ArrowDownToLine size={17} />
                        </a>
                      )}
                    </div>
                  </div>
                  {tableFilter && (
                    <button
                      className={styles.clearFilter}
                      onClick={() => setTableFilter(null)}
                    >
                      Table {tableFilter} <X size={14} />
                    </button>
                  )}
                  <div
                    className={`${styles.deskContent} ${selected ? styles.hasDetail : ""} ${view === "floor" ? styles.floorWorkspace : ""}`}
                  >
                    <div className={styles.reservationWorkspace}>
                      {view === "list" ? (
                        <div className={styles.reservationList}>
                          <div className={styles.listHead}>
                            <span>TIME / PARTY</span>
                            <span>GUEST</span>
                            <span>TABLE</span>
                            <span>STATUS</span>
                          </div>
                          {loading && !data ? (
                            <div className={styles.empty}>
                              Loading the reservation book…
                            </div>
                          ) : filtered.length === 0 ? (
                            <div className={styles.empty}>
                              <CalendarDays size={28} />
                              <h3>
                                {search || tableFilter
                                  ? "No matching reservations."
                                  : tab === "waitlist"
                                    ? "No waiting guests."
                                    : "No reservations."}
                              </h3>
                              <p>
                                {tab === "waitlist"
                                  ? "Waiting parties will appear here."
                                  : "Add a reservation or change the date."}
                              </p>
                            </div>
                          ) : (
                            filtered.map((r) => (
                              <button
                                key={r.id}
                                className={styles.reservationRow}
                                aria-pressed={selectedId === r.id}
                                onClick={() => selectGuest(r.id)}
                              >
                                <span>
                                  <strong>{timeLabel(r.time)}</strong>
                                  <small>
                                    <Users size={12} />
                                    {r.partySize} guests
                                  </small>
                                </span>
                                <span>
                                  <strong>
                                    {r.name}
                                    {!!data?.visitSummaries?.[r.id]?.completedVisits && <span className={styles.returning}>Returning · {data.visitSummaries[r.id].completedVisits} prior visits</span>}
                                    {r.occasion && <em>{r.occasion}</em>}
                                  </strong>
                                  <small>
                                    {(r.match && r.match.kind !== "none"
                                      ? matchLabel(r.match)
                                      : r.notes) ||
                                      (r.source === "walk_in"
                                        ? "Walk-in"
                                        : r.source === "phone"
                                          ? "Booked by staff"
                                          : "Online reservation")}
                                  </small>
                                </span>
                                <span className={styles.tableNumber}>
                                  {r.tableId ? `T${r.tableId}` : "—"}
                                </span>
                                <span
                                  className={styles.status}
                                  data-status={r.status}
                                >
                                  {STATUS_LABEL[r.status]}
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      ) : view === "floor" ? (
                        <ShiftFloor
                          reservations={reservations}
                          visitSummaries={data?.visitSummaries}
                          parties={filtered}
                          settings={settings}
                          time={floorTime}
                          selected={selected}
                          tableId={tableFilter || undefined}
                          assigning={assigning}
                          onTime={setFloorTime}
                          onTable={selectTable}
                          onGuest={selectGuest}
                          busy={busy}
                          error={assigning ? error : ""}
                          onWalkIn={startWalkIn}
                          onCancelAssignment={() => setAssigning(false)}
                        />
                      ) : (
                        <div className={styles.timelineScroll}>
                          <div className={styles.timeline}>
                            <div className={styles.timelineHead}>
                              <span>TABLE</span>
                              {Array.from({ length: 15 }, (_, i) => (
                                <span key={i}>{i + 9}:00</span>
                              ))}
                            </div>
                            {TABLES.map((t) => (
                              <div className={styles.timelineRow} key={t.id}>
                                <strong>
                                  T{t.id}
                                  <small>{t.seats} seats</small>
                                </strong>
                                <div>
                                  {reservations
                                    .filter(
                                      (r) =>
                                        r.tableId === t.id &&
                                        !["cancelled", "no_show"].includes(
                                          r.status,
                                        ),
                                    )
                                    .map((r) => (
                                      <button
                                        key={r.id}
                                        data-status={r.status}
                                        style={{
                                          left: `${(Math.max(0, minutes(r.time) - 540) / 900) * 100}%`,
                                          width: `${(Math.min(r.duration, 1440 - minutes(r.time)) / 900) * 100}%`,
                                        }}
                                        aria-label={`${r.name}, ${timeLabel(r.time)}, ${r.partySize} guests, ${STATUS_LABEL[r.status]}`}
                                        onClick={() => selectGuest(r.id)}
                                      >
                                        {r.name}
                                        <small>{r.partySize} guests</small>
                                      </button>
                                    ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {selected && (
                      <aside
                        className={`${styles.detail} ${assigning ? styles.assigningDetail : ""}`}
                      >
                        <div className={styles.panelHeading}>
                          <span className={styles.eyebrow}>GUEST DETAILS</span>
                          <button
                            className={styles.iconButton}
                            aria-label="Close guest details"
                            onClick={() => {
                              setSelectedId(null);
                              setAssigning(false);
                            }}
                          >
                            <X size={17} />
                          </button>
                        </div>
                        <span
                          className={styles.status}
                          data-status={selected.status}
                        >
                          {STATUS_LABEL[selected.status]}
                        </span>
                        <h2>{selected.name}</h2>
                        <p>
                          {timeLabel(selected.time)} · {selected.partySize}{" "}
                          guests
                          <br />
                          {dateLabel(selected.date)}
                        </p>
                        <section className={styles.visitSummary} aria-label="Venue visit history">
                          <span className={styles.eyebrow}>AT THIS VENUE</span>
                          <strong>{!selectedVisits?.matchedBy ? "Visit history unavailable" : selectedVisits.completedVisits ? `Returning guest · ${selectedVisits.completedVisits} prior completed ${selectedVisits.completedVisits === 1 ? "visit" : "visits"}` : "No prior completed visits"}</strong>
                          {selectedVisits?.lastVisit && <p>Last visit · {dateLabel(selectedVisits.lastVisit)}</p>}
                          <small>{selectedVisits?.matchedBy ? `Matched by booking ${selectedVisits.matchedBy}. Shared contact details can represent different guests.` : "No matching contact evidence. Guests are never linked by name alone."}</small>
                        </section>
                        <div className={styles.detailContacts}>
                          {selected.email && (
                            <a href={`mailto:${selected.email}`}>
                              {selected.email}
                            </a>
                          )}
                          {selected.phone && (
                            <a href={`tel:${selected.phone}`}>
                              {selected.phone}
                            </a>
                          )}
                        </div>
                        {selected.occasion && (
                          <span className={styles.occasion}>
                            {selected.occasion}
                          </span>
                        )}
                        {(venue.features.fixtures || selected.match?.kind !== "none") && <div className={styles.detailNote}>
                          <span>MATCH PREFERENCE</span>
                          <p>{matchLabel(selected.match)}</p>
                        </div>}
                        <div className={styles.detailNote}>
                          <span>GUEST NOTES</span>
                          <p>{selected.notes || "No special requests."}</p>
                        </div>
                        <div className={styles.detailNote}>
                          <span>STAFF NOTES · PRIVATE</span>
                          <p>{selected.staffNotes || "No staff notes yet."}</p>
                        </div>
                        {selected.tableId && (
                          <label className={styles.assignment}>
                            Assigned table
                            <select
                              value={selected.tableId}
                              disabled={
                                busy ||
                                !["confirmed", "arrived"].includes(
                                  selected.status,
                                )
                              }
                              onChange={(e) =>
                                update({ tableId: e.target.value })
                              }
                            >
                              {TABLES.filter(
                                (t) => t.seats >= selected.partySize,
                              ).map((t) => (
                                <option key={t.id} value={t.id}>
                                  T{t.id} · {t.seats} seats · {AREAS[t.area]}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <div className={styles.detailActions}>
                          {[
                            "confirmed",
                            "arrived",
                            "waitlisted",
                            "seated",
                          ].includes(selected.status) && (
                            <button
                              disabled={busy}
                              className={styles.secondaryButton}
                              onClick={() => {
                                setView("floor");
                                setFloorTime(["seated", "waitlisted"].includes(selected.status) ? timeString(venueNow().minutes) : selected.time);
                                setAssigning(true);
                              }}
                            >
                              {selected.status === "seated"
                                ? "Move to another table"
                                : selected.status === "waitlisted"
                                  ? "Choose table & seat"
                                  : "Choose table on floor"}
                            </button>
                          )}
                          {TRANSITIONS[selected.status].map((next) => (
                            <button
                              key={next}
                              disabled={busy}
                              className={
                                next === "seated" ||
                                next === "completed" ||
                                next === "confirmed"
                                  ? styles.primaryButton
                                  : styles.secondaryButton
                              }
                              onClick={() => {
                                if (["cancelled", "no_show"].includes(next))
                                  setConfirmation(next);
                                else void update({ status: next });
                              }}
                            >
                              {next === "seated"
                                ? "Seat guest"
                                : next === "arrived"
                                  ? "Mark arrived"
                                  : next === "completed"
                                    ? "Finish visit"
                                    : next === "confirmed"
                                      ? "Confirm table"
                                      : next === "cancelled"
                                        ? "Cancel reservation"
                                        : "Mark no-show"}
                            </button>
                          ))}
                          {["confirmed", "arrived", "waitlisted"].includes(
                            selected.status,
                          ) && (
                            <button
                              className={styles.textButton}
                              onClick={() => setEditOpen(true)}
                            >
                              Edit reservation &amp; notes
                            </button>
                          )}
                          {!["confirmed", "arrived", "waitlisted"].includes(
                            selected.status,
                          ) && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                const form = new FormData(e.currentTarget);
                                void update({
                                  staffNotes: form.get("staffNotes"),
                                });
                              }}
                            >
                              <label>
                                Update private notes
                                <textarea
                                  name="staffNotes"
                                  key={selected.id}
                                  defaultValue={selected.staffNotes}
                                  maxLength={2000}
                                />
                              </label>
                              <button
                                className={styles.secondaryButton}
                                disabled={busy}
                              >
                                Save notes
                              </button>
                            </form>
                          )}
                        </div>
                        <details className={styles.history}>
                          <summary>Data source</summary>
                          <p>
                            {selected.provenance
                              ? `${selected.provenance.environment === "local_preview" ? "Local sample" : "OpenRes"} · ${selected.provenance.createdBy === "staff" ? "Entered by staff" : "Entered by guest"} · ${selected.source}`
                              : "Legacy record · source evidence was not recorded"}
                          </p>
                          {selected.provenance && (
                            <>
                              {(venue.features.fixtures || selected.match?.kind !== "none") && <p>
                                Match:{" "}
                                {selected.provenance.match.source.replaceAll(
                                  "_",
                                  " ",
                                )}
                              </p>}
                              <p>
                                Recorded{" "}
                                {new Date(
                                  selected.provenance.recordedAt,
                                ).toLocaleString("en-US", {
                                  timeZone: venue.timeZone,
                                })}{" "}
                                {venue.timeZone}
                              </p>
                              <p className={styles.sourceId}>
                                Record {selected.id} · version{" "}
                                {selected.version}
                              </p>
                            </>
                          )}
                        </details>
                        <details className={styles.history}>
                          <summary>Reservation history</summary>
                          {[...selected.history].reverse().map((h, i) => (
                            <p key={i}>
                              <strong>
                                {h.action}
                                {h.version ? ` · v${h.version}` : ""}
                              </strong>
                              {h.fields && (
                                <small>Fields: {h.fields.join(", ")}</small>
                              )}
                              {h.state && (
                                <small>
                                  {h.state.date} · {h.state.time} ·{" "}
                                  {h.state.partySize} guests ·{" "}
                                  {h.state.tableId
                                    ? `T${h.state.tableId}`
                                    : "No table"}{" "}
                                  · {h.state.status}
                                </small>
                              )}
                              <small>
                                {new Date(h.at).toLocaleString("en-US", {
                                  timeZone: venue.timeZone,
                                })}{" "}
                                {venue.timeZone} · {h.actor}
                              </small>
                            </p>
                          ))}
                        </details>
                      </aside>
                    )}
                  </div>
                </>
              )}
            </>
          )}
          {tab === "settings" && data?.manager && (
            <SettingsPanel
              key={date}
              initial={data.settings}
              onSaved={() => load(true)}
            />
          )}
          <footer className={styles.deskFooter}>
            <span>
              {tab === "guests"
                ? "Most recent 5,000 reservations"
                : "Refreshes every 15 seconds"}
            </span>
            <span>All times {venue.timeZone}</span>
          </footer>
        </main>
      </div>
      {newOpen && (
        <NewReservation
          date={date}
          initialSource={newSource}
          tableId={newTable}
          waitlist={tab === "waitlist"}
          onClose={() => setNewOpen(false)}
          onSaved={(saved) => {
            changeDate(saved.date);
            setNotice(saved.status === "seated" ? "Walk-in seated." : "Guest added to the book.");
            if (saved.date === date) void load(true);
          }}
        />
      )}
      {editOpen && selected && (
        <ReservationEditor
          reservation={selected}
          busy={busy}
          error={error}
          onSave={update}
          onClose={() => setEditOpen(false)}
        />
      )}
      {confirmation && selected && (
        <Modal
          busy={busy}
          title={
            confirmation === "cancelled"
              ? "Cancel this reservation?"
              : "Mark this guest as a no-show?"
          }
          onClose={() => setConfirmation(null)}
        >
          <div className={styles.bookingForm}>
            <p>
              {selected.name} · {selected.partySize} guests ·{" "}
              {timeLabel(selected.time)}. This releases their table.
            </p>
            <ErrorMessage error={error} />
            <button
              disabled={busy}
              className={styles.dangerButton}
              onClick={() => update({ status: confirmation })}
            >
              {busy ? "Saving…" : "Confirm"}
            </button>
            <button
              className={styles.secondaryButton}
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Go back
            </button>
          </div>
        </Modal>
      )}
      {guest && (
        <Modal title="Guest history" onClose={() => setGuest(null)}>
          <div className={styles.bookingForm}>
            {guests
              .find(([key]) => key === guest)?.[1]
              .map((r) => (
                <div className={styles.guestHistoryItem} key={r.id}>
                  <strong>{r.name}</strong>
                  <p>
                    {dateLabel(r.date)} · {timeLabel(r.time)} · {r.partySize}{" "}
                    guests
                  </p>
                  <span className={styles.status} data-status={r.status}>
                    {STATUS_LABEL[r.status]}
                  </span>
                </div>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
