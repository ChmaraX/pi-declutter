# pi-declutter

[![CI](https://github.com/ChmaraX/pi-declutter/actions/workflows/ci.yml/badge.svg)](https://github.com/ChmaraX/pi-declutter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-declutter)](https://www.npmjs.com/package/pi-declutter)
[![License](https://img.shields.io/github/license/ChmaraX/pi-declutter)](LICENSE)

<p align="center">
  <a href="#features">features</a> · <a href="#install">install</a> · <a href="#keybindings">keybindings</a> · <a href="CHANGELOG.md">changelog</a>
</p>

**[Pi](https://pi.dev), decluttered.** See what the agent did at a glance,
with every detail one click away.

https://github.com/user-attachments/assets/838f4769-1945-45ff-8d2c-046bd57059e6

## Features

- **One card per response.** Tool calls fold into short, grouped summaries.
- **The answer stays in front.** Thinking and progress updates move into the
  card.
- **Expand what you need.** Click a row, or press Pi's `Ctrl+O` to expand
  everything.
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

## Keybindings

| Key | Action |
| --- | --- |
| Click | Expand a card or group, or open a row |
| `Ctrl+O` | Expand or collapse all cards (Pi's own key) |

In an open row:

| Key | Action |
| --- | --- |
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | Scroll |
| `c` | Copy the plain text |
| `Esc` `q` or click outside | Close |

## Limitations

- **Progress updates can briefly show outside the card.** Pi doesn't mark text
  as a progress update or as the final answer, so it streams as a normal
  message first and moves into the card once the agent's next step starts.

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
