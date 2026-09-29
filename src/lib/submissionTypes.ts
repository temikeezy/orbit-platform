/**
 * What the file picker offers, mirroring `SUBMISSION_TYPES` in convex/files.ts.
 *
 * Kept in step with the server deliberately. Offering a file type the server
 * then refuses means the rejection arrives AFTER the upload completes — the
 * most expensive possible moment to discover it, and doubly so for an intern on
 * a metered connection or a shared device.
 *
 * Extensions rather than MIME types, because browsers disagree about what a
 * .csv or .xls is: Windows commonly reports `application/vnd.ms-excel` for a
 * plain CSV, and an accept list written in MIME types alone silently hides
 * files the server would have taken.
 */
export const SUBMISSION_FILE_ACCEPT = [
  // documents
  '.pdf', '.doc', '.docx', '.odt', '.txt', '.md',
  // spreadsheets — the tracker and costed-budget tasks need these
  '.xlsx', '.xls', '.csv', '.ods',
  // slides
  '.pptx',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  // bundles
  '.zip',
].join(',');

/** The server's cap, stated once so the UI cannot drift from it. */
export const SUBMISSION_MAX_MB = 15;
