# Feature

1. Size it. An experiment → the answer is the product and the code is thrown away. A change to code already here → say the approach in a few sentences. A new subsystem or a changed interface → a written design first. Bigger than it looked → stop and step up; never down.
2. Name the example you are copying and the helpers you will reuse, before writing anything.
3. Agree what done means before building: acceptance criteria, non-goals, the signatures others will call, the edge cases, the check. Ambiguity that changes the work → ask once, now. A revised plan keeps every earlier correction.
4. Tests first, for the criteria and the named edge cases. Run them: they must fail because the behaviour is missing. Green now means they test nothing.
5. Tests assert behaviour, not how it is built. Reuse the fixtures already here. Mock only what cannot be run.
6. Build until they pass, without touching them. No code for cases that cannot happen.
7. Name one wrong implementation that would still pass. If there is one, add the test that kills it.
8. The project's own checks. Lint failure → the tool's safe autofix first, then the code — never an ignore.
9. Delete what the change orphaned. Update only the docs whose truth changed; search for the old value.
