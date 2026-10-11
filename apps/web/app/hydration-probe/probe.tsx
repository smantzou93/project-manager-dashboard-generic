'use client';

import { useEffect, useState } from 'react';

/** Minimal client component. If this does not become interactive, the problem
 *  is the framework or the install, not any application code. */
export function Probe() {
  const [n, setN] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div>
      <p id="probe-mounted">effect-ran: {String(mounted)}</p>
      <button id="probe-button" onClick={() => setN((x) => x + 1)}>
        count: {n}
      </button>
    </div>
  );
}
