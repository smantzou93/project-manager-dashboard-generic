import { Probe } from './probe';
export const dynamic = 'force-dynamic';
export default function Page() {
  return (
    <main>
      <h1>Hydration probe</h1>
      <Probe />
    </main>
  );
}
