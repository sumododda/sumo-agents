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

const ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi;

const GENERIC = /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{48,}(?![A-Za-z0-9+_=-])/g;

const MARK = '[redacted]';

export function redact(text) {
  let count = 0;
  const hit = () => {
    count++;
    return MARK;
  };

  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, hit);
  out = out.replace(ASSIGNMENT, (_m, name, sep) => {
    count++;
    return `${name}${sep}${MARK}`;
  });
  out = out.replace(GENERIC, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? hit() : m));

  return { text: out, count };
}
