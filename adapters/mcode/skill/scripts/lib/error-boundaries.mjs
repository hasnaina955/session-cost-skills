// Translate an expected operational failure into one readable line.
//
// The rule this encodes: a user should never be shown a stack trace or a full local
// path for something they can act on (a corrupt database, a locked file, a missing
// table), and a failure must never be laundered into an empty successful report.
const STORAGE_CAUSES = [
  { match: /not a database|malformed|corrupt|file is encrypted/i, reason: 'the file is not a readable database' },
  { match: /no such table/i, reason: 'the database is missing an expected table' },
  { match: /no such column/i, reason: 'the database schema is missing an expected column' },
  { match: /database is locked|being used by another process/i, reason: 'the database is locked by another process' },
  { match: /disk i\/o error|permission denied|access is denied/i, reason: 'the file could not be read' },
  { match: /unable to open database/i, reason: 'the database could not be opened' },
];

// Strip anything that looks like a filesystem path or a source frame, so a fallback
// message can never quote the user's home directory or the install location.
export function redactPaths(message) {
  return String(message ?? '')
    .replace(/file:\/\/\S+/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/(?:\/[\w.-]+){2,}/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** One short clause describing why a storage operation failed, with no paths or stacks. */
export function describeStorageError(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error ?? '');
  const cause = STORAGE_CAUSES.find((entry) => entry.match.test(message));
  if (cause) return cause.reason;
  const trimmed = message.split('\n')[0] ?? '';
  return trimmed.trim() ? redactPaths(trimmed) : 'the storage layer reported an unknown error';
}

/** True when a failure is an expected operational condition rather than a defect. */
export function isExpectedFailure(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error ?? '');
  return STORAGE_CAUSES.some((entry) => entry.match.test(message));
}

/**
 * Guard a read of local storage so a corrupt or foreign file produces a concise,
 * actionable error instead of an uncaught driver exception. Returns the value, or
 * throws an Error whose message is safe to print verbatim.
 */
export function withStorageBoundary(operation, { subject }) {
  try {
    return operation();
  } catch (error) {
    throw new Error(`${subject} could not be read: ${describeStorageError(error)}`);
  }
}
