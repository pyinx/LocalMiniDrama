# WorkBuddy

WorkBuddy reads no hooks in this version. It gets the harness through:

1. The marker block written by `hx sync` (always loaded): in `AGENTS.md`, or in `HX.md` when
   `AGENTS.md` is yours. Whether WorkBuddy expands the `@HX.md` import is not verified, so in
   that layout read `HX.md` yourself; `hx context` says when it applies.
2. The `hx-*` skills, discovered from `~/.workbuddy/skills`.

The model therefore runs `hx context` at the start and `hx check` before claiming
completion on its own. Nothing else changes: the rules and artifacts are identical.
