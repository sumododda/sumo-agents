# Review

1. Judge the change, not its author's account of it. A report is claims; a stated reason never makes a finding smaller.
2. First — does it do what was asked? Missing: asked for, not there. Extra: there, not asked for. Misunderstood: the wrong thing, built well. Check every requirement and every named edge case against the change.
3. Then — can it be trusted? Wrong behaviour, a regression, damaged data or a race, a broken interface, a check that was weakened, changed behaviour with no test, tests that assert nothing.
4. Read the change, not the codebase. Look outside it only for a risk you can name — callers of a changed signature, users of changed shared state — one look per risk, and say what you looked at.
5. The change touches sign-in or permissions, input parsing, SQL, file paths, shell commands, secrets or deserialising → follow what an outsider controls to where it lands. Never call code secure; say what you could not see.
6. Every finding: file:line, how it fails in one concrete case, the smallest fix or test. Reread those lines before reporting it; if they do not say what you thought, it is not a finding. No praise, no rewrites, nothing the project's linter would catch or does not enforce.
7. Severity, honestly. Important = cannot be trusted until fixed. Everything else is Minor: listed, never a reason to reopen the work.
8. What the change alone cannot show goes under "Could not verify" — do not widen the search to find out.
9. Nothing found → say so, then the residual risks and what is untested.

**Receiving a review.** Findings are claims too: check each against the code before acting, and if one is wrong for this codebase, say why. One unclear → clarify before fixing any. Fix one at a time and re-run what covers it. A re-review reads only the fix.
