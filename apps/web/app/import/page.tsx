import { getLabels, listProjects } from '@pmdash/db/queries';

import { ImportClient } from './import-client';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const [projects, labels] = await Promise.all([listProjects(), getLabels()]);

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Import a CSV</h1>
          <p>
            Bring {labels.workItem.toLowerCase()}s in from a spreadsheet or an export. Nothing is
            written until you have seen exactly what would change.
          </p>
        </div>
      </div>

      <ImportClient projects={projects.map((p) => ({ key: p.key, name: p.name }))} />
    </main>
  );
}
