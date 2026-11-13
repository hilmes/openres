"use client";
import { venue } from '@/config/venue';
import { AREAS, TABLES, minutes, venueNow, type Reservation, type Settings } from '@/lib/openres/model';
import styles from './openres.module.css';
export function tableReservationAt(reservations: Reservation[], tableId: string, time: string) {
  return reservations.find(r => r.tableId === tableId && r.status === 'seated') || reservations.find(r =>
    r.tableId === tableId && ['confirmed','arrived'].includes(r.status) && minutes(r.time) <= minutes(time) && minutes(r.time) + r.duration > minutes(time));
}
export function FloorMap({ reservations, settings, time, selected, assigning, busy = false, onSelect }: {
  reservations: Reservation[]; settings: Settings; time: string; selected?: string; assigning?: boolean; busy?: boolean; onSelect: (id: string) => void;
}) {
  const clock = venueNow();
  return <div className={styles.planScroll}>
    <div className={styles.architectPlan} style={{ aspectRatio: `${venue.floor.width} / ${venue.floor.height}` }} role="group" aria-label={`Venue floor plan at ${time}`}>
      <svg viewBox={`0 0 ${venue.floor.width} ${venue.floor.height}`} aria-hidden="true" className={styles.planDrawing}>
        <rect x="25" y="25" width={venue.floor.width-50} height={venue.floor.height-50} rx="8" fill="none" stroke="currentColor" strokeWidth="2" opacity=".3" />
        <text x={venue.floor.width/2} y="65" textAnchor="middle" fill="currentColor" fontSize="18" opacity=".5">{venue.floor.label}</text>
      </svg>
      {TABLES.map(t => {
        const r = tableReservationAt(reservations, t.id, time);
        const state = settings.disabledTables.includes(t.id) ? 'disabled' : r?.status === 'seated' ? 'seated' : r?.status === 'arrived' ? 'arrived' : r ? 'reserved' : 'free';
        const elapsed = r ? Math.max(0, (Date.parse(clock.date) - Date.parse(r.date))/60000 + clock.minutes - minutes(r.time)) : 0;
        return <button disabled={busy && assigning} key={t.id} className={styles.planTable} style={{ left: `${t.x*100}%`, top: `${t.y*100}%` }} data-shape={t.shape} data-state={state} data-assigning={assigning || undefined} aria-pressed={selected === t.id} aria-label={`Table ${t.id}, ${t.seats} seats, ${AREAS[t.area]}, ${state}${r ? `, ${r.name}` : ''}`} onClick={() => onSelect(t.id)}>
          <strong>{t.id}</strong><small>{r ? r.status === 'seated' ? `${elapsed}m` : `${r.partySize}/${t.seats}` : `${t.seats} seats`}</small>
        </button>;
      })}
    </div>
  </div>;
}
