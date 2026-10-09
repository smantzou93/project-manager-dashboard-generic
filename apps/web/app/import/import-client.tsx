'use client';

/**
 * CSV import.
 *
 * The first thing anyone cloning this repo will try, and the one with
 * consequences that are tedious to undo. So the flow is deliberately three
 * steps, and the destructive one is last and explicit:
 *
 *   inspect  → what is in this file, and how would it be read?   (writes nothing)
 *   dry run  → what exactly would change?                        (writes nothing)
 *   import   → do it                                             (requires a click)
 */

import { useRef, useState } from 'react';

type Stage = 'idle' | 'inspecting' | 'inspected' | 'running' | 'dry' | 'done';

type Inspect = {
  columns: string[];
  rows: number | null;
  details: Record<string, string | number>;
  warnings: string[];
  mapping: { columns: Record<string, string> };
  missing_required: string[];
};

type Outcome = {
  rows_read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  transitions: number;
  unknown_terms: Record<string, Record<string, number>>;
  aborted: string | null;
  dry_run: boolean;
  correlation_id: string;
};

export function ImportClient({ projects }: { projects: { key: string; name: string }[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [project, setProject] = useState(projects[0]?.key ?? '');
  const [stage, setStage] = useState<Stage>('idle');
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const post = async (command: string): Promise<unknown> => {
    const body = new FormData();
    body.set('file', file!);
    body.set('command', command);
    if (project) body.set('project', project);
    const response = await fetch('/api/import', { method: 'POST', body });
    const json: unknown = await response.json();
    if (!response.ok) {
      const e = json as { error?: { message: string; correlationId: string } };
      throw new Error(
        e.error ?
          `${e.error.message} (ref ${e.error.correlationId})`
        : `Upload failed (${response.status})`,
      );
    }
    return json;
  };

  const choose = async (chosen: File) => {
    setFile(chosen);
    setOutcome(null);
    setError(null);
    setStage('inspecting');
    try {
      const body = new FormData();
      body.set('file', chosen);
      body.set('command', 'inspect');
      const response = await fetch('/api/import', { method: 'POST', body });
      const json: unknown = await response.json();
      if (!response.ok) {
        const e = json as { error?: { message: string } };
        throw new Error(e.error?.message ?? 'Could not read that file.');
      }
      setInspect(json as Inspect);
      setStage('inspected');
    } catch (err) {
      setError((err as Error).message);
      setStage('idle');
    }
  };

  const go = async (command: 'dry-run' | 'import') => {
    setStage('running');
    setError(null);
    try {
      setOutcome((await post(command)) as Outcome);
      setStage(command === 'import' ? 'done' : 'dry');
    } catch (err) {
      setError((err as Error).message);
      setStage('inspected');
    }
  };

  const noHistory =
    inspect &&
    !['created_at', 'started_at', 'completed_at'].some((f) =>
      Object.values(inspect.mapping.columns).includes(f),
    );

  return (
    <>
      {error ?
        <div className="card error-card" role="alert">
          <strong>{error}</strong>
        </div>
      : null}

      <section
        className={`dropzone ${dragging ? 'dropzone-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const dropped = e.dataTransfer.files[0];
          if (dropped) void choose(dropped);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt"
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            if (chosen) void choose(chosen);
          }}
        />
        <strong>{file ? file.name : 'Drop a CSV here'}</strong>
        <span className="muted">
          {file ?
            `${(file.size / 1024).toFixed(0)} KB`
          : 'or click to choose a file — nothing is written until you confirm'}
        </span>
        <button type="button" className="chip" onClick={() => inputRef.current?.click()}>
          {file ? 'Choose a different file' : 'Choose a file'}
        </button>
      </section>

      {stage === 'inspecting' ?
        <p className="muted">Reading the file…</p>
      : null}

      {inspect && stage !== 'idle' ?
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>What is in this file</h2>
          <p className="defn">
            {inspect.rows} rows, {inspect.columns.length} columns · {inspect.details.encoding},
            delimiter{' '}
            <code>
              {String(inspect.details.delimiter) === '\t' ? 'tab' : inspect.details.delimiter}
            </code>
            {Number(inspect.details.header_row) > 1 ?
              `, header on row ${inspect.details.header_row}`
            : ''}
          </p>

          {inspect.warnings.map((w) => (
            <p key={w} className="muted">
              ⚠ {w}
            </p>
          ))}

          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Column in your file</th>
                  <th scope="col">Read as</th>
                </tr>
              </thead>
              <tbody>
                {inspect.columns.map((column) => {
                  const mapped = inspect.mapping.columns[column];
                  return (
                    <tr key={column}>
                      <td>{column}</td>
                      <td>
                        {mapped ?
                          <span className="badge badge-ok">{mapped}</span>
                        : <span className="muted">kept as metadata</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {inspect.missing_required.length ?
            <p className="muted">
              <strong>Cannot import:</strong> no column maps to{' '}
              {inspect.missing_required.join(', ')}.
            </p>
          : null}

          {/* Said before the import, not after. It is the single highest-value
              thing a user can fix, and discovering it from an empty chart a
              day later is a bad experience. */}
          {noHistory ?
            <p className="muted">
              ⚠ No date columns were recognised, so these items will have no history. Cycle time and
              the cumulative flow diagram will not include them. If your file has created or
              completed dates, map them.
            </p>
          : null}

          <div className="add-row">
            <label className="muted" htmlFor="project">
              Import into
            </label>
            <select
              id="project"
              className="field"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} — {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="chip chip-add"
              disabled={stage === 'running' || inspect.missing_required.length > 0}
              onClick={() => void go('dry-run')}
            >
              {stage === 'running' ? 'Working…' : 'Dry run (writes nothing)'}
            </button>
          </div>
        </section>
      : null}

      {outcome ?
        <section className="card">
          <h2>{outcome.dry_run ? 'What would happen' : 'Imported'}</h2>
          <p className="defn">
            {outcome.dry_run ?
              'Nothing has been written. The full pipeline ran inside a transaction that was rolled back.'
            : `Committed. Reference ${outcome.correlation_id}.`}
          </p>

          <div className="tiles">
            <Stat label="Rows read" value={outcome.rows_read} />
            <Stat label="New" value={outcome.inserted} />
            <Stat label="Updated" value={outcome.updated} />
            <Stat label="Unchanged" value={outcome.unchanged} />
            <Stat label="Rejected" value={outcome.rejected} tone={outcome.rejected ? 'bad' : ''} />
            <Stat label="History built" value={outcome.transitions} />
          </div>

          {Object.entries(outcome.unknown_terms).map(([field, values]) => (
            <p key={field} className="muted">
              Unknown <strong>{field}</strong> values, reported rather than created:{' '}
              {Object.entries(values)
                .map(([v, n]) => `${v} (${n})`)
                .join(', ')}
              . Add them in Vocabulary, or correct the file.
            </p>
          ))}

          {outcome.aborted ?
            <p className="muted">
              <strong>Refused:</strong> {outcome.aborted}
            </p>
          : null}

          {outcome.dry_run && !outcome.aborted ?
            <div className="add-row">
              {/* The only destructive action on the page, and it is reached
                  only after the user has seen exactly what it will do. */}
              <button
                type="button"
                className="chip chip-danger"
                disabled={stage === 'running'}
                onClick={() => void go('import')}
              >
                Import {outcome.inserted + outcome.updated} rows into {project}
              </button>
              <span className="muted">This writes to the database.</span>
            </div>
          : null}

          {stage === 'done' ?
            <p className="muted">
              Rejected rows are in <code>ingestion_rejects</code> — fix them in the source file and
              re-import. Re-running is safe; nothing is duplicated.
            </p>
          : null}
        </section>
      : null}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <dl className="tile">
      <dt>{label}</dt>
      <dd style={tone === 'bad' && value > 0 ? { color: 'var(--bad)' } : undefined}>{value}</dd>
    </dl>
  );
}
