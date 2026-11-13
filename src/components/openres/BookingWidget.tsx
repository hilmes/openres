"use client";
import { venue } from "@/config/venue";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ArrowUpRight, CalendarDays, ChevronRight, Users } from "lucide-react";
import {
  addDays,
  AREAS,
  dateLabel,
  matchLabel,
  minutes,
  timeLabel,
  venueNow,
  type Area,
  type GuestReservation,
  type BookingFixture,
  type MatchPreference,
} from "@/lib/openres/model";
import { api, downloadCalendar, ErrorMessage, Modal } from "./shared";
import { MatchPicker } from "./MatchPicker";
import styles from "./openres.module.css";

type Availability = {
  slots: { time: string; areas: Area[] }[];
  enabled: boolean;
  advanceDays: number;
  duration: number;
  local: boolean;
};
type Receipt = {
  reservation: GuestReservation;
  token: string;
  emailed: boolean;
};
export type BookingWidgetProps = {
  initialDate?: string;
  initialPartySize?: number;
  initialTime?: string;
  initialNotes?: string;
  className?: string;
  fixtures?: BookingFixture[];
  initialMatch?: MatchPreference;
  initialFixtureId?: string;
  onBooked?: (reservation: GuestReservation) => void;
};

/** Embeddable guest flow; the host calendar supplies the surrounding UI and prefills. */
export function BookingWidget({
  initialDate,
  initialPartySize = 2,
  initialTime = "18:00",
  initialNotes = "",
  className = "",
  fixtures,
  initialMatch,
  initialFixtureId,
  onBooked,
}: BookingWidgetProps) {
  const [match, setMatch] = useState<MatchPreference | null>(
    initialMatch || (venue.features.fixtures || fixtures || initialFixtureId ? null : { kind: "none" }),
  );
  const [allowPrefill, setAllowPrefill] = useState(true);
  const [today] = useState(() => venueNow().date);
  const [date, setDate] = useState(
    initialMatch?.kind === "fixture"
      ? initialMatch.fixture.date
      : initialDate || today,
  );
  const [partySize, setPartySize] = useState(initialPartySize);
  const [area, setArea] = useState<Area | "any">("any");
  const [timePreference, setTimePreference] = useState(
    initialMatch?.kind === "fixture" ? initialMatch.fixture.time : initialTime,
  );
  const [data, setData] = useState<Availability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<{
    time: string;
    waitlist: boolean;
  } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [bookingError, setBookingError] = useState("");
  const [notice, setNotice] = useState("");
  const [showAll, setShowAll] = useState(false);
  const requestId = useRef("");
  const [refresh, setRefresh] = useState(0);
  const chooseMatch = useCallback((choice: MatchPreference) => {
    setMatch(choice);
    if (choice.kind === "fixture") {
      setDate(choice.fixture.date);
      setTimePreference(choice.fixture.time);
    }
    setShowAll(false);
  }, []);
  useEffect(() => {
    if (!match) return;
    const abort = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear old availability before fetching the newly selected date/party.
    setLoading(true);
    setError("");
    setData(null);
    api<Availability>(
      `/api/openres/availability?date=${date}&partySize=${partySize}&area=${area}`,
      { signal: abort.signal },
    )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [date, partySize, area, refresh, match]);
  const select = (time: string, waitlist = false) => {
    requestId.current = crypto.randomUUID();
    setBookingError("");
    setSelection({ time, waitlist });
  };
  const book = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selection || busy) return;
    setBusy(true);
    setBookingError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<Receipt>("/api/openres/reservations", {
        method: "POST",
        body: JSON.stringify({
          id: requestId.current,
          date,
          time: selection.time,
          partySize,
          area,
          name: form.get("name"),
          email: form.get("email"),
          phone: form.get("phone"),
          notes: form.get("notes"),
          website: form.get("website"),
          match,
          waitlist: selection.waitlist,
        }),
      });
      setReceipt(result);
      setSelection(null);
      setRefresh((v) => v + 1);
      onBooked?.(result.reservation);
    } catch (e) {
      setBookingError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copyLink = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Link copied.");
    } catch {
      setNotice("Copy the link from your browser or confirmation below.");
    }
  }, []);
  const slots = [...(data?.slots || [])]
    .sort(
      (a, b) =>
        Math.abs(minutes(a.time) - minutes(timePreference)) -
        Math.abs(minutes(b.time) - minutes(timePreference)),
    )
    .slice(0, showAll ? undefined : 9)
    .sort((a, b) => a.time.localeCompare(b.time));
  const managementLink = receipt
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/manage#${receipt.reservation.id}.${receipt.token}`
    : "";
  return (
    <div
      className={`${styles.guest} ${styles.widget} ${className}`}
      data-openres-private
    >
      {!match ? (
        <MatchPicker
          fixtures={fixtures}
          initialFixtureId={allowPrefill ? initialFixtureId : undefined}
          onSelect={chooseMatch}
        />
      ) : (
        <>
          {(venue.features.fixtures || fixtures || initialMatch || initialFixtureId) && <div className={styles.chosenMatch}>
            <div>
              <small>MATCH PREFERENCE</small>
              <strong>{matchLabel(match)}</strong>
              {match.kind === "fixture" && (
                <small>
                  {dateLabel(match.fixture.date)} ·{" "}
                  {timeLabel(match.fixture.time)} kickoff
                </small>
              )}
            </div>
            <button
              className={styles.textButton}
              onClick={() => {
                setAllowPrefill(false);
                setMatch(null);
                setData(null);
              }}
            >
              Change
            </button>
          </div>}
          <section aria-label={`Reserve at ${venue.name}`} className={styles.booking}>
            <div className={styles.formGrid}>
              <label>
                <span>
                  <Users size={14} /> Guests
                </span>
                <select
                  value={partySize}
                  onChange={(e) => setPartySize(Number(e.target.value))}
                >
                  {Array.from({ length: 8 }, (_, i) => (
                    <option key={i} value={i + 1}>
                      {i + 1} {i ? "guests" : "guest"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>
                  <CalendarDays size={14} /> Date
                </span>
                <input
                  type="date"
                  aria-label="Reservation date"
                  value={date}
                  disabled={match.kind === "fixture"}
                  min={today}
                  max={addDays(today, data?.advanceDays || 30)}
                  onChange={(e) => {
                    if (e.target.value) {
                      setDate(e.target.value);
                      setShowAll(false);
                    }
                  }}
                />
              </label>
            </div>
            <div className={styles.formGrid}>
              <label>
                <span>Near</span>
                <input
                  type="time"
                  step={900}
                  value={timePreference}
                  onChange={(e) => setTimePreference(e.target.value)}
                />
              </label>
              <label>
                <span>Seating</span>
                <select
                  value={area}
                  onChange={(e) => setArea(e.target.value as Area | "any")}
                >
                  <option value="any">Anywhere</option>
                  {Object.entries(AREAS).map(([key, name]) => (
                    <option value={key} key={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div
              className={styles.availability}
              aria-live="polite"
              aria-busy={loading}
            >
              <div className={styles.availabilityLabel}>
                <span>{loading ? "Checking tables…" : "AVAILABLE TIMES"}</span>
                <span>{venue.timeZone}</span>
              </div>
              <ErrorMessage error={error} />
              {error && (
                <button
                  className={styles.secondaryButton}
                  onClick={() => setRefresh((v) => v + 1)}
                >
                  Try again
                </button>
              )}
              {loading ? (
                <div className={styles.skeletonSlots}>
                  {Array.from({ length: 6 }, (_, i) => (
                    <span key={i} />
                  ))}
                </div>
              ) : data && !data.enabled ? (
                <div className={styles.empty}>
                  <h3>Online booking is closed.</h3>
                  <p>Contact the venue for assistance.</p>
                  <a
                    href={`mailto:${venue.contactEmail}`}
                    className={styles.primaryButton}
                  >
                    Contact the venue <ArrowUpRight size={15} />
                  </a>
                </div>
              ) : data && slots.length ? (
                <>
                  <div className={styles.slots}>
                    {slots.map((slot) => (
                      <button
                        key={slot.time}
                        aria-label={`Reserve at ${timeLabel(slot.time)}`}
                        onClick={() => select(slot.time)}
                      >
                        <strong>{timeLabel(slot.time)}</strong>
                        <span>{area === "any" ? "Table" : AREAS[area]}</span>
                      </button>
                    ))}
                  </div>
                  {data.slots.length > 9 && (
                    <button
                      className={styles.textButton}
                      onClick={() => setShowAll(!showAll)}
                    >
                      {showAll
                        ? "Show fewer times"
                        : `See all ${data.slots.length} times`}{" "}
                      <ChevronRight size={14} />
                    </button>
                  )}
                </>
              ) : data ? (
                <div className={styles.empty}>
                  <h3>No tables available.</h3>
                  <p>Try another date, party size, or seating area.</p>
                </div>
              ) : null}
            </div>
            {data?.enabled && (
              <div className={styles.waitlist}>
                <div>
                  <strong>Need another time?</strong>
                  <p>Request a spot on the waitlist.</p>
                </div>
                <button
                  className={styles.secondaryButton}
                  onClick={() => select(timePreference, true)}
                >
                  Join waitlist
                </button>
              </div>
            )}
            <p className={styles.bookingFoot}>
              For parties of more than 8, <a href={`mailto:${venue.contactEmail}`}>contact the venue</a>.{" "}
              <a href={`mailto:${venue.contactEmail}`}>Need help?</a>
            </p>
          </section>
        </>
      )}
      <span className={styles.notice} role="status">
        {notice}
      </span>
      {selection && (
        <Modal
          title={
            selection.waitlist ? "Join the waitlist" : `Reserve at ${venue.name}`
          }
          onClose={() => {
            if (!busy) setSelection(null);
          }}
        >
          <form onSubmit={book} className={styles.bookingForm}>
            <div className={styles.bookingSummary}>
              <strong>{venue.name}</strong>
              <span>
                {dateLabel(date)} · {timeLabel(selection.time)} · {partySize}{" "}
                guests
              </span>
              {(venue.features.fixtures || (match && match.kind !== "none")) && <small>{matchLabel(match || undefined)}</small>}
              <small>
                {selection.waitlist
                  ? "A waitlist request is not a confirmed reservation."
                  : `${data?.duration || 90} minute visit · ${venue.timeZone}`}
              </small>
            </div>
            {selection.waitlist && (
              <label>
                Preferred time
                <input
                  type="time"
                  step={900}
                  value={selection.time}
                  onChange={(e) =>
                    setSelection({ ...selection, time: e.target.value })
                  }
                  required
                />
              </label>
            )}
            <label>
              Full name
              <input
                name="name"
                autoComplete="name"
                required
                minLength={2}
                maxLength={100}
                placeholder="Your first and last name"
              />
            </label>
            <div className={styles.formGrid}>
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  placeholder="you@example.com"
                />
              </label>
              <label>
                Phone (optional)
                <input
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  minLength={7}
                  maxLength={32}
                  placeholder="(212) 555-0100"
                />
              </label>
            </div>
            <label>
              Seating requests (optional)
              <textarea
                name="notes"
                defaultValue={initialNotes}
                maxLength={1000}
                rows={3}
                placeholder="Anything we need to arrange for this visit?"
              />
            </label>
            <label className={styles.honeypot} aria-hidden="true">
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
            <ErrorMessage error={bookingError} />
            <p className={styles.finePrint}>
              Contact details are used to manage your reservation. {venue.name}
              keeps venue-only visit history. You can change or cancel using
              your private confirmation link.
            </p>
            <button className={styles.primaryButton} disabled={busy}>
              {busy
                ? "Saving your spot…"
                : selection.waitlist
                  ? "Join the waitlist"
                  : "Confirm reservation"}
              <ChevronRight size={16} />
            </button>
          </form>
        </Modal>
      )}
      {receipt && (
        <Modal
          title={
            receipt.reservation.status === "waitlisted"
              ? "Waitlist request received"
              : "Reservation confirmed"
          }
          onClose={() => setReceipt(null)}
        >
          <div className={styles.receipt}>
            <h3>
              {receipt.reservation.status === "waitlisted"
                ? "Waitlist request received"
                : "Your reservation is confirmed"}
            </h3>
            <p>
              {dateLabel(receipt.reservation.date)} ·{" "}
              {timeLabel(receipt.reservation.time)}
              <br />
              {receipt.reservation.partySize} guests · {venue.name}
            </p>
            <p>
              {receipt.reservation.status === "waitlisted"
                ? "We’ll contact you if a table becomes available. Your table is not yet confirmed."
                : venue.address}
            </p>
            <p className={styles.finePrint}>
              {receipt.emailed
                ? "Your confirmation email is on its way."
                : "Email was not sent. Save your private link below to manage this reservation."}
            </p>
            <a href={managementLink} className={styles.primaryButton}>
              Manage your reservation <ArrowUpRight size={16} />
            </a>
            <button
              className={styles.secondaryButton}
              onClick={() => copyLink(managementLink)}
            >
              Copy private reservation link
            </button>
            {receipt.reservation.status !== "waitlisted" && (
              <button
                className={styles.textButton}
                onClick={() => downloadCalendar(receipt.reservation)}
              >
                Add to calendar <CalendarDays size={16} />
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
