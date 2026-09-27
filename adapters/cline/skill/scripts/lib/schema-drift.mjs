import { createHash } from 'node:crypto';

/**
 * Runtime storage schema drift detection.
 *
 * Both runtimes own their ledgers, and either can change a column name on any release. A renamed
 * column does not throw: `SELECT` returns `undefined` for a missing column, the aggregate treats
 * that as zero, and the report reads as a session that spent nothing. That is the silent-zero
 * failure this project treats as its worst bug class (principle 1), arriving through storage
 * rather than through pricing.
 *
 * So each adapter declares the columns it actually reads, and the observed schema is compared
 * against that declaration before any figure is computed. A missing required column is a loud,
 * named failure. An *extra* column is not a failure at all - a runtime that grows a column is
 * normal - but it is surfaced, because "newer than tested" is worth knowing.
 *
 * The functions here are pure: they take an observed schema as data so they can be tested without
 * a database, and take the database handle separately for the one function that reads it.
 */

/** Read the column names of every named table, using PRAGMA, without touching the data. */
export function observeSchema(db, tableNames) {
  const observed = {};
  for (const table of tableNames) {
    let columns;
    try {
      columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    } catch {
      // A missing table is a drift condition, not a crash: report it as absent.
      observed[table] = null;
      continue;
    }
    observed[table] = columns.length ? columns.map((column) => column.name) : null;
  }
  return observed;
}

/**
 * Compare an observed schema against what the adapter reads.
 *
 * `required` maps a table name to the columns this adapter reads. Returns a verdict rather than
 * throwing, so a caller can decide whether the drift is fatal for the command being run.
 */
export function checkSchema(observed, required) {
  const missingTables = [];
  const missingColumns = [];
  const extraColumns = [];
  const unexpectedTables = [];

  for (const [table, columns] of Object.entries(required)) {
    const present = observed[table];
    if (present === null || present === undefined) {
      missingTables.push(table);
      continue;
    }
    const presentSet = new Set(present);
    for (const column of columns) {
      if (!presentSet.has(column)) missingColumns.push({ table, column });
    }
  }

  for (const [table, present] of Object.entries(observed)) {
    if (present === null || present === undefined) continue;
    if (!Object.hasOwn(required, table)) {
      unexpectedTables.push(table);
      continue;
    }
    const requiredSet = new Set(required[table]);
    for (const column of present) {
      if (!requiredSet.has(column)) extraColumns.push({ table, column });
    }
  }

  const drifted = missingTables.length > 0 || missingColumns.length > 0;
  return {
    status: drifted ? 'drifted' : (extraColumns.length || unexpectedTables.length) ? 'newer' : 'ok',
    missingTables,
    missingColumns,
    extraColumns,
    unexpectedTables,
    fingerprint: fingerprintSchema(observed),
  };
}

/**
 * A stable fingerprint of the observed schema, so a report or a `doctor` run can say exactly
 * which schema it read. Two runs against the same schema always produce the same value; it
 * carries no row data and nothing that could identify a session.
 */
export function fingerprintSchema(observed) {
  const canonical = Object.keys(observed).sort().map((table) => [table, [...(observed[table] ?? [])].sort()]);
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

/**
 * One readable line naming exactly what is missing, or null when the schema is usable.
 *
 * A drift message has to be actionable by someone who did not write the adapter: it names the
 * table, the column, and that the runtime's storage changed. It deliberately does not suggest a
 * fix, because the correct fix depends on which runtime version introduced the change.
 */
export function describeDrift(verdict, { runtimeId } = {}) {
  if (!verdict || verdict.status !== 'drifted') return null;
  const who = runtimeId ? `The ${runtimeId} ` : '';
  const parts = [];
  for (const table of verdict.missingTables) parts.push(`the table \`${table}\` is missing`);
  for (const { table, column } of verdict.missingColumns) {
    parts.push(`\`${table}.${column}\` is missing`);
  }
  return `${who}storage schema has changed and this version cannot read it: ${parts.join('; ')}. `
    + 'The ledger may be from a newer or older runtime than this skill supports. '
    + 'Update the skill, or point --data-dir at a ledger this version understands. '
    + 'No figure in this report is trustworthy.';
}

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}
