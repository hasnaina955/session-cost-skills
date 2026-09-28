/**
 * The Cline fixture factory, as a module the conformance command can load.
 *
 * `run-conformance.mjs <adapter-module> <fixture-factory>` takes a module whose default export is a
 * zero-argument function returning a fixture, so a runtime's fixture is wrapped rather than pointed
 * at directly. The standard factory already returns everything the kit needs; this exists so the
 * documented command works verbatim, and so a new runtime has a file to copy.
 *
 *   node tests/conformance/run-conformance.mjs \
 *     adapters/cline/skill/scripts/lib/runtime.mjs \
 *     tests/conformance/cline-fixture.mjs \
 *     tests/conformance/cline-ambiguous-fixture.mjs
 */
import { createClineFixture } from '../helpers/contract-fixtures.mjs';

export default function createFixture() {
  return createClineFixture();
}
