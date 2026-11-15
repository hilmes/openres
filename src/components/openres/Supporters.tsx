"use client";
import { useEffect, useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import { supporterTally, timeLabel, type Reservation } from "@/lib/openres/model";
import { api } from "./shared";
import { usePaths } from "./paths";
import styles from "./openres.module.css";

/** The service's fixtures with the guests booked for each side, so hosts can seat and screen for the room they will have. */
export function SupporterTally({ reservations }: { reservations: Reservation[] }) {
  const tally = supporterTally(reservations);
  if (!tally.length) return null;
  return (
    <section className={styles.supporterTally} aria-label="Supporters booked">
      <h2>Supporters booked</h2>
      <ul>
        {tally.map(({ fixture, home, away, neutral }) => (
          <li key={fixture.id}>
            <time>{timeLabel(fixture.time)}</time>
            <span><strong>{fixture.home}</strong> {home}</span>
            <span><strong>{fixture.away}</strong> {away}</span>
            <span>Neutral {neutral}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Team = { team: string; guests: number; contactable: number };
/**
 * Manager's guest book: the teams guests have booked with. Choosing one filters the book;
 * the download holds only the guests who asked to hear about that team.
 */
export function SupporterPanel({ filter, onFilter }: { filter: string | null; onFilter: (team: string | null) => void }) {
  const paths = usePaths();
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    api<{ teams: Team[] }>(`${paths.api}/supporters`, { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted) setTeams(data.teams);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [paths.api]);
  if (error) return <p role="alert" className={styles.empty}>The supporter list is unavailable right now.</p>;
  if (!teams.length) return null;
  return (
    <section className={styles.supporterPanel} aria-label="Supporters">
      <h2>Supporters</h2>
      <p>Guests who chose a team when booking. Each download lists only the guests who asked to be emailed about that team.</p>
      <ul>
        {teams.map((t) => (
          <li key={t.team}>
            <button type="button" aria-pressed={filter === t.team} onClick={() => onFilter(filter === t.team ? null : t.team)}>
              <strong>{t.team}</strong>
              <small>{t.guests} {t.guests === 1 ? "guest" : "guests"} · {t.contactable} asked for updates</small>
            </button>
            {t.contactable > 0 && (
              <a
                className={styles.iconButton}
                href={`${paths.api}/supporters?team=${encodeURIComponent(t.team)}&format=csv`}
                aria-label={`Download the ${t.team} supporter list`}
              >
                <ArrowDownToLine size={17} />
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
