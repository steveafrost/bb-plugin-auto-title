---
name: auto-title
description: Configure Auto Title's milestone checks, title protection, and model sources in BB.
---

Auto Title checks whether a title still fits after every ten human messages by
default. It keeps fitting or unattributed titles and changes only stale titles.

- `bb auto-title sources` lists live model sources and readiness.
- `bb auto-title source <source-id>` selects one. Automatic tries custom,
  BB Cloud, compatible installed plugin RPCs, then the thread provider.
- `bb auto-title retitle <thread-id>` explicitly replaces a protected title and
  resumes automatic checks.
- `bb plugin config auto-title set interval <positive-integer>` changes the
  future interval.

Use BB’s AI services settings to select Auto Title for thread titles. Built-in
Regenerate title can clear title protection when its changed result is observed
at the next milestone. Set custom endpoint credentials through the secret field
in Auto Title’s plugin settings; don’t put them in chat or shell history.
