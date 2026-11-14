"use client";
import { venue } from "@/config/venue";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import {
  dateLabel,
  timeLabel,
  type GuestReservation,
} from "@/lib/openres/model";
import { usePaths } from "./paths";
import styles from "./openres.module.css";

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json().catch(() => ({
    error: "Unable to connect to OpenRes. Please try again.",
  }));
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || "Something went wrong. Please try again."),
      { status: response.status },
    );
  return data as T;
}
export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.modal}
      onCancel={(event) => {
        // React owns dismissal; native Escape must not hide an in-flight save.
        event.preventDefault();
        if (!busy) onClose();
      }}
      aria-busy={busy}
      aria-label={title}
    >
      <div className={styles.modalHead}>
        <h2>{title}</h2>
        <button
          className={styles.iconButton}
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Brand({ dark = false }: { dark?: boolean }) {
  const paths = usePaths();
  return (
    <a
      href={paths.book}
      className={`${styles.brand} ${dark ? styles.brandDark : ""}`}
      aria-label="OpenRes home"
    >
      <span className={styles.brandBall} aria-hidden="true">
        ✳
      </span>
      Open<span>Res</span>
      <span className={styles.brandPeriod}>.</span>
    </a>
  );
}
export function PreviewBanner({ local }: { local: boolean }) {
  const paths = usePaths();
  return local ? (
    <div className={styles.preview}>
      Local preview · Sample reservations · No guest emails sent{" "}
      <a href={paths.staff}>Open staff desk ↗</a>
    </div>
  ) : null;
}
export function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <p role="alert" className={styles.error}>
      {error}
    </p>
  ) : null;
}
export function downloadCalendar(r: GuestReservation) {
  const clean = (text: string) =>
    text
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/[,;]/g, "\\$&")
      .replace(/\r/g, "");
  const start = `${r.date.replaceAll("-", "")}T${r.time.replace(":", "")}00`;
  const endDate = new Date(`${r.date}T${r.time}:00Z`);
  endDate.setUTCMinutes(endDate.getUTCMinutes() + r.duration);
  const end = endDate.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenRes//Reservations//EN",
    "BEGIN:VEVENT",
    `UID:${r.id}@openres.local`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART;TZID=${venue.timeZone}:${start}`,
    `DTEND;TZID=${venue.timeZone}:${end}`,
    `SUMMARY:${clean(venue.name)} reservation`,
    `LOCATION:${clean(venue.address)}`,
    `DESCRIPTION:${clean(`${r.partySize} guests · ${dateLabel(r.date)} · ${timeLabel(r.time)}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/calendar;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "reservation.ics";
  a.click();
  URL.revokeObjectURL(url);
}
