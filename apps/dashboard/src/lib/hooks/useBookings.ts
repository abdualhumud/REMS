'use client';

import { useState } from 'react';
import { RECENT_BOOKINGS } from '@/lib/mock-data';
import { useMode } from '@/lib/mode-context';
import { getStagingSession } from '@/lib/staging-auth';

const MANUAL_BOOKINGS_KEY = 'rems-manual-bookings';

export type Booking = typeof RECENT_BOOKINGS[number];

/** Staging users get a per-user key so two trial accounts on one browser never share bookings. */
function storageKey(isStaging: boolean): string {
  if (!isStaging) return MANUAL_BOOKINGS_KEY;
  const u = getStagingSession();
  return u ? `rems-staging-${u.id}-manual-bookings` : MANUAL_BOOKINGS_KEY;
}

function loadManualBookings(key: string): Booking[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveManualBookings(key: string, bookings: Booking[]): void {
  try { localStorage.setItem(key, JSON.stringify(bookings)); }
  catch { /* storage quota */ }
}

/**
 * Manages the full booking list — merges mock data (demo) or localStorage data
 * (production/staging) with manually-added bookings.
 */
export function useBookings() {
  const { isDemo, isStaging } = useMode();
  const [key] = useState(() => storageKey(isStaging));

  const [manualBookings, setManualBookings] = useState<Booking[]>(() =>
    isDemo ? [] : loadManualBookings(key)
  );

  const allBookings: Booking[] = [
    ...(isDemo ? (RECENT_BOOKINGS as Booking[]) : []),
    ...manualBookings,
  ];

  const addBooking = (booking: Booking) => {
    const next = [booking, ...manualBookings];
    setManualBookings(next);
    if (!isDemo) saveManualBookings(key, next);
  };

  return { allBookings, addBooking };
}
