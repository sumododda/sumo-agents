/**
 * Secret shapes scrubbed before anything is stored. The store is local, but it
 * is also what gets sent to the cheap model, so nothing secret may reach it.
 *
 * The generic pattern deliberately excludes '/' and '.', and needs mixed case
 * plus a digit: without that it eats long file paths and 40-char git SHAs,
 * which memories legitimately contain.
 */
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

// The name may be the tail of a longer one (DB_PASSWORD, GITHUB_TOKEN) and may be quoted, as a JSON key is; what follows it must be the assignment itself.
const ASSIGNMENT = /(password|passwd|secret|token|api[_-]?key|access[_-]?key)(["']?\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi;

/** A value that is code, not a secret: a type (`token: string;`), or a member or a call it reads from (`credential.token`, `getPassword()`). Digits never pass for code. */
const CODE_VALUE = /^(?:(?:string|boolean|number|bigint|object|symbol|unknown|undefined|integer|buffer)(?:\[\])?|[a-z_$]+(?:\.[a-z_$]+)+|[a-z_$]+(?:\.[a-z_$]+)*\(\D*)[;,)]*$/i;

/** Whether an assignment's value could be the secret itself: a quoted one always could, and so could any in an env-style `NAME=value`. */
const holdsSecret = (sep, quote, value) => quote !== '' || !/[:\s]/.test(sep) || !CODE_VALUE.test(value);

/** A password inside a URL (`postgres://app:pw@db/app`): only the password goes; the scheme, the user and the host stay. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

const GENERIC = /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{48,}(?![A-Za-z0-9+_=-])/g;

const MARK = '[redacted]';

/**
 * What a line looks like, for a change under judgment: 'key' is a shape only a
 * real credential has (a PEM block, a vendor token, a JWT); 'maybe' is an
 * assignment to password= or token=, or a long random string — real in code,
 * fine in a fixture, so a person decides.
 */
export function secretShape(line) {
  // A private key spans lines, and a change is read one line at a time: its first line is enough.
  if (PATTERNS.some((p) => line.search(p) !== -1) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) return 'key';
  if (line.search(URL_PASSWORD) !== -1) return 'maybe';
  if ([...line.matchAll(ASSIGNMENT)].some(([, , sep, quote, value]) => holdsSecret(sep, quote, value))) return 'maybe';
  const long = line.match(GENERIC);
  if (long?.some((m) => /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m))) return 'maybe';
  return null;
}

export function redact(text) {
  let count = 0;
  const hit = () => {
    count++;
    return MARK;
  };

  // The URL first: a vendor token used as its password goes once, with the URL around it kept.
  let out = text.replace(URL_PASSWORD, (_m, head) => {
    count++;
    return `${head}${MARK}@`;
  });
  for (const pattern of PATTERNS) out = out.replace(pattern, hit);
  out = out.replace(ASSIGNMENT, (m, name, sep, quote, value) => {
    if (!holdsSecret(sep, quote, value)) return m;
    count++;
    return `${name}${sep}${MARK}`;
  });
  out = out.replace(GENERIC, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? hit() : m));

  return { text: out, count };
}
