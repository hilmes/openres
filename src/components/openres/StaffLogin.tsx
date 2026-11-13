"use client";
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { venue } from '@/config/venue';
import { api, Brand, ErrorMessage } from './shared';
import styles from './openres.module.css';
export function StaffLogin() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/openres/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
      router.push('/staff');
      router.refresh();
    } catch (error) { setError((error as Error).message); setBusy(false); }
  }
  return <main className={styles.guest} data-openres-private>
    <div className={`${styles.simpleGuest} ${styles.login}`}>
      <Brand /><h1>Staff sign-in</h1><p>{venue.name}</p>
      <form className={styles.bookingForm} onSubmit={submit}>
        <label>Username<input name="username" autoComplete="username" required maxLength={64} /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={1024} /></label>
        <ErrorMessage error={error} />
        <button className={styles.primaryButton} disabled={busy}>{busy ? 'Signing in…' : 'Open desk'}</button>
      </form>
    </div>
  </main>;
}
