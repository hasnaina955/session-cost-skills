/** The MCode fixture factory, in the shape the conformance command loads. See cline-fixture.mjs. */
import { createMCodeFixture } from '../helpers/contract-fixtures.mjs';

export default function createFixture() {
  return createMCodeFixture();
}
