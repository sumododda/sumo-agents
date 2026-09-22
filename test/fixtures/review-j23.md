## Summary
Does what the brief asked; not trustworthy as it stands — a stale `llama.path` pin crashes the
whole `mem` process instead of returning `{ok:false}`, and the chat request has no timeout, so
one exit path leaves llama-server running for as long as `mem` hangs.

## Asked vs built
Matches on every numbered item (config keys, TTY question, HEAD+size skip, .part+rename, redirects,
llama pin, doctor lines, backend flags/payload, `local:<file>` model_runs row, stand-in path).
Extra, not asked for: setup silently skips the download whenever SUMO_AGENTS_MODEL_CMD is set
(src/setup.mjs:160) — see Findings 3. Needed, though: test/helpers.mjs:21 puts that var in every
sandbox, so without the skip `npm test` would GET huggingface.co.
Missing/misunderstood: none.
Security answers: a redirect cannot change where bytes land — `dest` comes only from
`config.model.file` (src/setup.mjs:102), never from the URL, Location or Content-Disposition;
fetch rejects non-http(s) redirect schemes. `config.model.*` is reachable only through `mem config`
(src/apply.mjs has no meta/config op), so the scribe/dream model cannot steer the path.
The rename is atomic and crash-safe; it is not concurrency-safe (Minor 2).

## Findings
src/model.mjs:163-174 — `getMeta(db,'llama.path')` is trusted without checking the binary is still
  there, unlike `pinnedOrOnPath` (src/model.mjs:19-31) which accessSyncs the claude pin. Concrete:
  `mem setup` pins /opt/homebrew/bin/llama-server, user runs `brew uninstall llama.cpp`, next
  callLocalModel → `spawn` emits 'error' (ENOENT) with no listener → uncaught exception, the whole
  process dies with a stack trace. Verified: a 12-line repro of exactly this spawn call exits 1 with
  "Unhandled 'error' event". The brief required "never a throw". Smallest fix: `child.on('error', …)`
  and reject waitForHealth on it (accessSync before spawn alone still leaves the TOCTOU).
src/model.mjs:177-190 — the POST has no timeout, while callModel bounds itself with
  TIMEOUT_MS=180_000 (src/model.mjs:89). Concrete: llama-server goes healthy, then stalls mid-
  generation; the fetch never settles, the `finally` at :206 never runs, `mem` hangs forever and
  llama-server stays up holding the GPU. Smallest fix: `signal: AbortSignal.timeout(TIMEOUT_MS)`.
src/setup.mjs:160-161,168 — when the skip fires there is no output line at all, so the run is
  indistinguishable from `--no-model`. Concrete: a user with SUMO_AGENTS_MODEL_CMD exported runs
  `mem setup` (no model line), `mem doctor` says "warn router model — run: mem setup", they run it
  again, nothing happens, forever, with no explanation anywhere. Acceptable as a mechanism, a trap
  as built. Smallest fix: when skipDownload came from the env var, push
  `model     not downloaded — SUMO_AGENTS_MODEL_CMD is set`.

## Minor
src/setup.mjs:107-109 — `Number(head.headers.get('content-length'))` is 0, not NaN, when the header
  is absent, so Number.isFinite never guards it; a HEAD without Content-Length (common on a JFrog
  remote that has not cached the artifact) re-downloads 2.5 GB on every `mem setup`. Fix: skip when
  the header is missing and the file exists.
src/setup.mjs:114-116 — `${dest}.part` is a fixed name and is never removed on failure. Two
  concurrent `mem setup` runs interleave into one .part, then one renames it: a corrupt GGUF whose
  size matches, so the check at :109 reports "present" forever. An interrupted download also leaves
  multi-GB of .part behind. Fix: `${dest}.${process.pid}.part` plus `rmSync(partPath,{force:true})`
  in the catch.
src/model.mjs:170-171 — freePort closes the socket before spawn binds it; two callLocalModel calls
  can be handed the same port, and waitForHealth cannot tell someone else's llama-server from its
  own (both answer status:ok) or notice its child already exited, so a lost race costs the full 60 s.
  Harmless today (nothing calls it), must be handled by the job that wires it in.
src/setup.mjs:106,113,119 — the failure line echoes the full URL, so a source pasted as
  `https://user:token@artifactory/...` prints the token on stdout, which is also what a sub-agent's
  transcript captures. Fix: strip userinfo before interpolating.
src/setup.mjs:102 — `mem config model.file ../bin/mem` makes setup overwrite the launcher. Only the
  user can set it, so this is footgun, not attack surface. Fix: reject a value containing a separator.
src/setup.mjs:112-115 — the GET is unbounded; a server may stream past its advertised Content-Length
  until the disk fills. Checksums were an explicit non-goal, a byte cap was not.
test/router-model-setup.test.mjs:46-48 — the "skips it" case asserts only the printed word; it never
  proves a second GET did not happen. A hit counter on the fixture server would close that.

## Could not verify
The real backend beyond the two guard clauses: spawn→health→POST→kill is untested, as its author
states. Nothing shows llama-server is killed on the success path, on the 60 s timeout, or on a
thrown fetch — the hand run mentioned in the brief covers success only.
Whether the user's llama.cpp build defaults `--host` to 127.0.0.1; none is passed, so on a build
that defaults to 0.0.0.0 the model is served to the LAN unauthenticated for the call's duration.
Whether `--reasoning-budget 0` and `chat_template_kwargs` are accepted by the installed llama-server
version; an unknown flag makes it exit at once, which here reads as a 60 s health timeout.
`npm test` → 99 pass, 0 fail (matches the report).

## Learned
none
