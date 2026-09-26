# pi-declutter

[![CI](https://github.com/ChmaraX/pi-declutter/actions/workflows/ci.yml/badge.svg)](https://github.com/ChmaraX/pi-declutter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-declutter)](https://www.npmjs.com/package/pi-declutter)
[![License](https://img.shields.io/github/license/ChmaraX/pi-declutter)](LICENSE)

<p align="center">
  <a href="#features">features</a> · <a href="#install">install</a> · <a href="#usage">usage</a> · <a href="#limitations">limitations</a> · <a href="CHANGELOG.md">changelog</a>
</p>

**[Pi](https://pi.dev), decluttered.** See what the agent did at a glance,
with every detail one click away.

Inspired by the activity feed in the Codex app.

<!-- video: a response running, the card growing, settling, clicking into a row -->

## Features

- **One card per response.** Tool calls fold into short, grouped summaries.
- **The answer stays in front.** Thinking and progress updates move into the
  card.
- **Expand what you need.** Click a row, press `Ctrl+Shift+A`, or use Pi's
  `Ctrl+O`.
- **Full detail on click.** Live output, diffs, syntax highlighting, Markdown
  and links. `c` copies.
  <!-- screenshot: output modal -->

Works with every provider (Anthropic, OpenAI Codex, Cursor and more) and
every tool, including MCP servers and tools from other extensions.

## Install

```bash
pi install npm:pi-declutter
```

Restart Pi. Pi shows a notice when a new release lands; update with
`pi update --extensions`. To follow `main` instead of releases, install
`git:github.com/ChmaraX/pi-declutter`.

## Usage

Just use Pi. The card appears on its own.

| Action | How |
| --- | --- |
| Collapse / expand a card | Click its header |
| Show a group's calls | Click the group row |
| Open full output, thinking or narration | Click the row |
| Scroll · copy · close the modal | `↑` `↓` `PgUp` `PgDn` · `c` · `Esc` or click outside |
| Cycle the newest card (keyboard) | `Ctrl+Shift+A` |
| Check the runtime hooks | `/activity-patch` |

| Option | Effect |
| --- | --- |
| `pi --no-activity-mouse` | Turn off clicks. `Ctrl+Shift+A` still works. |
| `PI_ACTIVITY_DEBUG=1` | Write the component tree to `/tmp/activity-feed-debug.log` (override with `PI_ACTIVITY_DEBUG_LOG`) |

## Limitations

- **Clicks take over mouse selection.** Hold `Shift` (or `Option` in iTerm2)
  to select text, or use `--no-activity-mouse`. Pi's fullscreen renderer
  doesn't have this problem.
- **`Ctrl+T` no longer shows thinking.** Thinking lives only in the card's
  Thought rows.
- **It patches Pi internals.** Pi has no hook for these features, so the
  extension patches four internals. Each patch is checked at startup and
  turns itself off if Pi changes. `/activity-patch` shows their status.
- It only changes the display. It registers no tools and doesn't touch the
  prompt, so the model sees the same conversation.
- TUI only. It does nothing in `-p` print mode.

## Development

```bash
git clone https://github.com/ChmaraX/pi-declutter && cd pi-declutter
npm install
pi install "$PWD"
```

`npm run check` type-checks. `npm test` runs the unit tests. Run `/reload` in
Pi to pick up source changes. PR titles follow
[Conventional Commits](https://www.conventionalcommits.org/); release-please
writes the changelog, tags releases and publishes to npm.

## License

[MIT](LICENSE)
