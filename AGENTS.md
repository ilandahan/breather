# Working on breather

Notes for a coding agent sending a change to this repo. Humans are welcome to
read them too.

## What this repo is

One Claude Code skill plus five hooks and a status line. The skill decides when
to offer a stopping point; the hooks supply the only thing the model cannot know
on its own, which is what time it is and how long the person has been here.

`breather` is Claude Code specific by construction. The clock line is injected
by a `UserPromptSubmit` hook, and presence is accumulated by hooks on four
events. There is no portable version of that for an agent runtime without
hooks, so this repo does not claim to run on one.

## Layout

```
skills/breather/SKILL.md              the skill — what the model reads
skills/breather/references/           handoff template
hooks/*.mjs                           the five hooks, the shared store, the status line
hooks/hooks.json                      hook wiring for plugin installs
.claude-plugin/                        plugin.json and marketplace.json
scripts/build-installer.mjs            embeds the tree above into install.mjs
scripts/test-install.mjs               behavior check for the installer
install.mjs                            generated and committed — this is what people run
```

## The one rule that will bite you

`install.mjs` is **generated**. It carries the whole source tree as a base64
payload so that the install stays a single command with no clone and no build
step. Edit anything under `skills/` or `hooks/`, then:

```
npm run build     # re-embed the tree into install.mjs
npm run check     # syntax
npm test          # install into a throwaway home and assert behavior
```

Commit the regenerated `install.mjs` along with your change. CI fails the build
if the two have drifted, because a stale payload means the one-liner installs
code that is not in the repo.

Never hand-edit the `PAYLOAD` constant.

## What the tests actually assert

`scripts/test-install.mjs` runs the real installer against an injected
`CLAUDE_HOME` and checks the promises the README makes: files land
byte-identical, four events register, re-running is idempotent, unrelated hooks
and settings survive the merge, a foreign status line is left alone without
`--force`, `--dry-run` writes nothing, and `--uninstall` removes only its own
entries.

The home is always injected and never discovered. A test that reads the real
`~/.claude` passes or fails based on the machine it ran on, which tells you
nothing about the code.

## Design constraints that are not up for negotiation

These are the product, not preferences. A change that breaks one of them is a
different tool.

- **It does not measure.** No hours logged, no score, no count-up. The one
  number shown counts down to a break.
- **It does not lecture.** No comment on hours, no mention of health.
- **It does not block.** Every offer is declinable, and an ignored offer is a no.
- **It does not push toward more work.** Subscription usage may only ever be
  used to support stopping. Remaining quota is never presented as headroom.
- **Two clocks, never mixed in one sentence.** `rest` is about the person,
  `usage` is about the account. "Three hours in and you're at 83%" is a
  performance report, which is the thing this tool exists not to be.

`DESIGN.md` has the reasoning behind each of these.

## Style

Match the surrounding code. No new dependencies — the whole thing is Node
stdlib on purpose, so that the installer can be one file and audited by reading
it. No build tooling beyond the one script above.
