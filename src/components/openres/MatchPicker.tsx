"use client";
import { venue } from "@/config/venue";
import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, Plus } from "lucide-react";
import {
  dateLabel,
  timeLabel,
  type BookingFixture,
  type MatchPreference,
} from "@/lib/openres/model";
import { api } from "./shared";
import styles from "./openres.module.css";

export function MatchPicker({
  fixtures: supplied,
  initialFixtureId,
  onSelect,
}: {
  fixtures?: BookingFixture[];
  initialFixtureId?: string;
  onSelect: (match: MatchPreference) => void;
}) {
  const [fixtures, setFixtures] = useState<BookingFixture[]>(supplied || []);
  const [loading, setLoading] = useState(!supplied);
  const [error, setError] = useState("");
  const [other, setOther] = useState(false);
  const [search, setSearch] = useState("");
  const [request, setRequest] = useState("");
  const [limit, setLimit] = useState(8);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (supplied) return;
    const abort = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronize loading status with an external catalog fetch/retry.
    setLoading(true);
    setError("");
    api<{ fixtures: BookingFixture[] }>("/api/openres/fixtures", {
      signal: abort.signal,
    })
      .then((data) => {
        if (!abort.signal.aborted) setFixtures(data.fixtures);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [supplied, retry]);
  useEffect(() => {
    if (initialFixtureId) {
      const selected = fixtures.find((f) => f.id === initialFixtureId);
      if (selected) onSelect({ kind: "fixture", fixture: selected });
    }
  }, [fixtures, initialFixtureId, onSelect]);
  const filtered = fixtures.filter((f) =>
    `${f.home} ${f.away} ${f.competition} ${f.date}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  function submit(e: FormEvent) {
    e.preventDefault();
    if (request.trim().length >= 2)
      onSelect({ kind: "other", request: request.trim() });
  }
  return (
    <section className={styles.matchPicker} aria-label="Choose a match">
      <h2>What are you here to watch?</h2>
      <p>Pick a fixture, request another match, or skip for no preference.</p>
      {!other && (
        <>
          <label className={styles.fixtureSearch}>
            <span className={styles.eyebrow}>UPCOMING FIXTURES</span>
            {fixtures.length > 8 && (
              <input
                aria-label="Find a fixture"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search teams, competition, or date"
              />
            )}
          </label>
          <div aria-live="polite" aria-busy={loading}>
            {loading ? (
              <p className={styles.matchMessage}>Loading fixtures…</p>
            ) : error ? (
              <p className={styles.matchMessage}>
                Fixtures are unavailable. You can still choose Other or Skip.{" "}
                <button
                  className={styles.textButton}
                  onClick={() => setRetry((v) => v + 1)}
                >
                  Try again
                </button>
              </p>
            ) : filtered.length === 0 ? (
              <p className={styles.matchMessage}>
                No fixtures found. Choose Other to request a match, or Skip.
              </p>
            ) : (
              filtered.slice(0, limit).map((f) => (
                <button
                  className={styles.fixtureRow}
                  key={f.id}
                  onClick={() => onSelect({ kind: "fixture", fixture: f })}
                >
                  <span>
                    <small>
                      {dateLabel(f.date)} · {timeLabel(f.time)} {venue.timeZone}
                    </small>
                    <strong>
                      {f.home} <span>vs</span> {f.away}
                    </strong>
                    <small>{f.competition}</small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              ))
            )}
          </div>
          {filtered.length > limit && (
            <button
              className={styles.textButton}
              onClick={() => setLimit((v) => v + 12)}
            >
              More fixtures
            </button>
          )}
        </>
      )}
      <div className={styles.matchOptions}>
        <button
          className={styles.otherMatch}
          onClick={() => setOther((v) => !v)}
          aria-expanded={other}
        >
          <Plus size={18} />
          <span>OTHER</span>
        </button>
        <button
          className={styles.skipMatch}
          onClick={() => onSelect({ kind: "none" })}
        >
          SKIP <ChevronRight size={15} />
        </button>
      </div>
      {other && (
        <form className={styles.otherForm} onSubmit={submit}>
          <label>
            Which match?
            <input
              autoFocus
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              required
              minLength={2}
              maxLength={240}
              placeholder="Teams or match you’d like to watch"
            />
          </label>
          <button className={styles.primaryButton}>
            Continue <ChevronRight size={15} />
          </button>
          <p className={styles.finePrint}>
            We’ll pass your request to the team. Screening is subject to
            confirmation.
          </p>
        </form>
      )}
    </section>
  );
}
