/**
 * Fixtures where current-selection must refuse rather than guess.
 *
 * ## Why these are not the standard fixtures
 *
 * The kit's ambiguity scenario needs two live root sessions at once, and "live" is the one thing
 * the two runtimes genuinely disagree on: Cline reads a `status` column, MCode reads how recently a
 * call landed. A single shared fixture cannot produce both cases, so the fixture factories own
 * them - which is also where a new runtime would put its own.
 *
 * Nothing else about the fixture changes: the sessions, their costs and their ledger contents are
 * identical to the standard fixture, so a refusal here is about selection alone and cannot be
 * caused by a different dataset.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createClineFixture, createMCodeFixture } from '../helpers/contract-fixtures.mjs';

/**
 * A Cline fixture with two live root sessions.
 *
 * Cline's resolver treats `idle`, `running` and `pending` as live, so two roots set to `running`
 * must be refused. Everything else is left alone, so any difference in output is attributable to
 * the selection alone.
 */
export function createClineAmbiguousFixture() {
  const fixture = createClineFixture();
  const database = new DatabaseSync(path.join(fixture.dataDir, 'data', 'db', 'sessions.db'));
  database.prepare("UPDATE sessions SET status = 'running', ended_at = NULL WHERE session_id IN ('cline-root', 'cline-other')").run();
  database.close();
  return fixture;
}

/**
 * A MCode fixture with two live root sessions.
 *
 * MCode decides liveness from how recently a session's last call landed, and the standard fixture
 * already has two roots inside that window, so no change is needed. This is here so the contract is
 * uniform: every runtime supplies the same five handles and the same ambiguous fixture, whether
 * that is a different dataset or the standard one.
 */
export function createMCodeAmbiguousFixture() {
  return createMCodeFixture();
}

export default {
  cline: createClineAmbiguousFixture,
  mcode: createMCodeAmbiguousFixture,
};
