import { venue } from "@/config/venue";
import { BookingWidget, type BookingWidgetProps } from "./BookingWidget";
import { PreviewBanner } from "./shared";
import styles from "./openres.module.css";

export function GuestPage({
  local,
  ...prefill
}: BookingWidgetProps & { local: boolean }) {
  return (
    <div className={styles.guest}>
      <PreviewBanner local={local} />
      <main className={styles.simpleGuest}>
        <header className={styles.simpleGuestHeader}>
          <div>
            <span className={styles.eyebrow}>OPENRES</span>
            <h1>Book {venue.name}</h1>
            <p>{venue.address}</p>
          </div>
          {venue.website && <a href={venue.website}>Venue website ↗</a>}
        </header>
        <BookingWidget {...prefill} />
        <footer className={styles.simpleFooter}>
          {venue.menuUrl && <a href={venue.menuUrl}>Menu</a>}
          <a href="/staff">
            Staff desk
          </a>
        </footer>
      </main>
    </div>
  );
}
