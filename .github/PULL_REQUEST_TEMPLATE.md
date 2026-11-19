## What changed

<!-- A short description of the change. Link the issue it closes, if any: Closes #12 -->

## Why

<!-- The problem this solves. Behaviour that looks odd is sometimes intentional — say what was wrong. -->

## How it was tested

Chrome MV3 content scripts are only replaced on page reload, so a stale build silently keeps running.
Please confirm each line before submitting:

- [ ] Reloaded the extension on `chrome://extensions` (↻), reloaded the page, and the panel header shows the **new** version
- [ ] Tested on a page **with** headings (`h2`–`h4`) — the layered web builds
- [ ] Tested on a page **without** headings (mail client / plain text) — it falls back instead of breaking
- [ ] If the AI or prompt layer changed: verified the structured output still parses, and a failed call degrades instead of emptying the web
- [ ] No third-party libraries were added

## Notes

<!-- Anything reviewers should know: trade-offs, follow-up work, panels/sizes you checked. -->
