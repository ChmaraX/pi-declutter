# pi-run-feed

A [pi](https://github.com/earendil-works) TUI extension that renders agent
activity (tool calls + thinking) the way the Codex GUI app does:

- **While the agent works** — the moment the first tool starts, an activity card
  is appended to the transcript **above** the streamed answer text, rendered in
  its **final shape from the start** and growing in place: a ticking header
  `⣯ Working · 4s` — an animated braille spinner using pi's own composer
  working-indicator frames, so it spins in lockstep with the working bar — with
  group-label rows accumulating underneath and updating their live counts
  (`• Read files, ran commands · 3 files, 2 commands`). A currently-running call
  shows the same spinner on its group row. Each built-in tool row
  (`read/bash/edit/write/grep/find/ls`) meanwhile collapses to a single compact
  dim line (`Read index.ts`, `Ran pnpm`); the native working message next to the
  editor mirrors the bucket counter.
- **When the response settles** — the same card settles *in place*: **only the
  header changes** to `Worked for 12s ▾` and the ticking stops — no other layout
  shift. It keeps the ordered flow of settled group rows and **expandable
  thought entries** (`· Thought 3s · <summary> ▸`), and a failure count in the
  header. The built-in tool rows are *absorbed* (render zero lines and vanish).
  There is **one card per agent response** (covering all its turns), not one per
  turn, and because it was appended early it sits above the final answer text.
  Failures stay calm (Codex-faithful): no auto-expand — the failure surfaces as
  the badge plus a `· N failed` header count.
- **The card is an ordered top-level flow**: the card is a sequence of **Group
  entries** and **Thought entries** in true event order — if the agent thinks,
  runs tools, thinks again, then runs one tool, the card shows exactly that
  sequence (thought, group, thought, singleton). Each Group entry is a tree:
  header → group rows → member rows. Group rows and the header expand
  **independently** via a chevron (`▸` collapsed / `▾` expanded) at the end of
  the row; a member row with output shows a static `▸` to mark it **openable**.
  Three card-level states: **full-collapse** (everything folds behind
  `Worked for Xs ▸`, the answer text stays), **default** (group rows visible,
  members hidden), and members expanded below that. Click a **group row** to
  reveal its member rows — each carries a **tool-family glyph** (`$` shell, `▤`
  read, `⌕` grep, `≡` list/find, `✎` edit/write, `◆` generic tool) and
  `<target> (<duration>)`. Click a **member row** with output to open a
  **floating output modal** — a focused, scrollable overlay with the **full**
  output (not an 8-line tail), a title bar (`<target> (<duration>)` + a
  `✓ Success` / `Exit code N` / `✗ Failed` badge), a `$ <command>` first line for
  command tools, and a footer hint (`↑/↓/PgUp scroll · c copy · Esc close`).
  Press **c** to copy the untruncated raw output to the clipboard.
  `read`/`edit`/`write` have no modal. Singleton groups render as the member row
  directly (no wrapper).
- **Thinking separates groups in chronological order**: thinking is a
  **top-level Thought entry** that sits between the groups it separated, never
  nested inside a group. A run of consecutive thinking spans is **coalesced
  into one** entry `· Thought 3s · <summary> ▸`, where `<summary>` is the first
  meaningful line of the kept span (captured from `message_update` thinking
  deltas, bounded ~2KB per span). Click it to open the **Thinking** modal with
  the captured text (scrollable, `c` to copy). **Meaningful thinking** (a
  coalesced run totalling ≥ 1s) closes the open group and becomes its own
  entry; **sub-threshold thinking is ignored entirely** — it does not break a
  group and does not render, which absorbs the bursty 1–4 ms spans so tool
  bursts without real thinking still form one fat group. A run that streamed no
  text degrades to a bare `· Thought 3s`. pi's **native** thinking block is
  suppressed (so it never appears twice) with supported levers only — a
  markdown transformer that blanks `assistant-thinking` (streaming + settled)
  plus `setHiddenThinkingLabel("")` for the `Ctrl+T`-hidden placeholder. See
  [Deviations from Codex](#deviations-from-codex) for the `Ctrl+T` interaction.

It uses supported pi extension APIs and **no prompt injection**. The one
exception is a single **guarded runtime patch** that removes the last blank
line supported APIs could not reach — see
[Blank-line patch guard](#blank-line-patch-guard); it is feature-detected,
fail-open, reversible, and touches only the render tree (never the
stored/resent message). The built-in tools are re-registered with their
execution preserved (the exported `create*ToolDefinition` factories are spread
and only `renderShell`/`renderCall`/`renderResult` are overridden, so
result/details shapes are unchanged); MCP/custom tool rows are left alone
(other extensions own them) but are still counted in the card.

## Install

```sh
git clone https://github.com/ChmaraX/pi-run-feed.git
```

The extension entry point is `src/index.ts`. Point pi at the cloned repo from
your `~/.pi/agent/settings.json` `packages` (or `extensions`) list:

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": [
    "/path/to/pi-run-feed"
  ]
}
```

`package.json` declares the entry via `pi.extensions` → `./src/index.ts`, so a
`packages` path to the repo root is enough. Alternatively list the file
directly:

```jsonc
{
  "extensions": [
    "/path/to/pi-run-feed/src/index.ts"
  ]
}
```

Then start pi normally. To try it without editing settings, load it ad-hoc
with the `-e` flag:

```sh
pi -e src/index.ts
```

Run `/reload` inside pi after editing the source to pick up changes without
restarting the session.

> The extension has no npm dependencies of its own — it imports only
> `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which the
> host provides. No `npm install` is required.

## Usage

Just use pi. The moment the agent runs its first tool, a live `⣯ Working · Xs`
card (the spinner animates with pi's working-bar frames) appears in the
transcript above the answer, rendered in its final shape and growing in place
while the tools run; the compact dim tool rows show below it. When the
response ends, only the header flips to `Worked for Xs ▾`, the ticking stops,
and the tool rows vanish.

| Action | How |
|--------|-----|
| Cycle the **newest** card: full-collapse → default → all-expanded → back | `Ctrl+Shift+A` |
| Full-collapse ↔ default for **one** card | Click its header |
| Show/hide a group's **members** | Click the group row |
| Open the **output modal** for a member | Click the member row |
| Open the **Thinking modal** for a thought | Click the `· Thought Ns · <summary>` row |
| Scroll the modal | `↑` / `↓` / `PgUp` / `PgDn` / `Home` / `End` |
| Copy the modal's full raw text | `c` |
| Close the modal | `Esc` (or `q`) |
| Check the blank-line patch's live status | `/activity-patch` |

Clicks are on by default (disable with `--no-activity-mouse`). Member rows
list each tool call with its tool-family glyph and `<target> (<duration>)`,
e.g. `▤ Read package.json (0.4s)`, `$ Ran git log --oneline -5 (0.3s)`; a row
with output shows a static `▸` marking it openable. Clicking it opens a
**floating modal** with the **full** output — scrollable and copyable —
instead of an inline box: a title bar (`<target> (<duration>)` + a
`✓ Success` / `Exit code N` / `✗ Failed` badge), a `$ <command>` first line
for commands, the whole output body, and a footer hint. For a truncated
command, the modal reads the untruncated output from the shell tool's temp
file (`fullOutputPath`). Failures do not auto-expand and rows stay neutral (no
red `✗`) — the modal badge carries the failure. Only one modal is open at a
time; clicking another row swaps its content.

### Deviations from Codex

- The card header appends `· N failed` when a response contains failed calls.
  Codex shows nothing at the collapsed level; the count stays so a collapsed
  TUI card cannot hide failures entirely (one-word cost, deliberate).
- **`Ctrl+T` is neutralized.** pi exposes no component hook for thinking
  rendering, only a markdown transformer + hidden-label lever. Blanking
  `assistant-thinking` makes the thinking *text* render **zero lines**, and
  absorbed built-in tool rows render **zero lines** including their own spacer
  (`renderShell:"self"` → `ToolExecutionComponent.render()` returns `[]` when
  the self-render container is empty, dropping the constructor `Spacer(1)`
  too). Because the transformer blanks the shown state and the label blanks
  the hidden state, pressing `Ctrl+T` no longer reveals a readable native
  thinking block — the card's expandable Thought rows are the single home for
  thinking.

Everything is TUI-only. In `-p`/print mode the extension loads and no-ops
cleanly (print mode emits no tool events), and the blank-line patch below is
never installed (it is gated on live TUI mode).

### Blank-line patch guard

Eliminating the empty gap needed a **guarded runtime patch**, because the
blanks were unreachable with supported APIs. `AssistantMessageComponent` adds
a `Spacer(1)` around thinking runs computed from the **raw, pre-transform**
message content: a **leading** blank whenever the message has any visible raw
content — including thinking — and a **trailing** blank after each thinking
run when visible content follows. Once the transformer blanks the thinking
body to zero rows, both become pure dead space: a `[thinking, toolCall…]`
message left one leading blank (a big task is dozens of such messages, so they
stacked additively), and a `[thinking, text]` answer left two blanks above the
text.

No supported lever removes them: `message_end` replacement is rejected
because pi mutates the finalized message in place for the provider-resent /
persisted context, so stripping thinking would break byte-identical context
and drop `thinkingSignature`.

**The patch strips every dead spacer around a suppressed thinking run, on any
message shape.** After pi builds the content container, it measures each
child's rendered height and removes the `Spacer`s that no longer separate two
visible blocks (i.e. those bordering a zero-row suppressed-thinking run or the
container edge), keeping exactly **one** leading margin when a real
text/markdown block renders. So `[thinking,text]` collapses to the same single
margin a plain `[text]` answer has, and `[thinking,tool]` drops to zero — all
asserted against pi's real component in the drift probe. Real paragraphs keep
their normal spacing untouched; the stored/resent message is never modified
(this is a render-tree edit applied after `updateContent`).

`src/patches.ts` installs a **feature-detected, fail-open, reversible** patch
(TUI mode only).

**It patches the LIVE component, not the imported class.** Patching
`AssistantMessageComponent.prototype` from the class the extension `import`s
has **zero live effect**: pi's CLI runs a **bundle**
(`dist/bundle/chunks/chunk-*.js`) whose `AssistantMessageComponent` is a
different class object than the unbundled `dist` the extension imports, and
the bundle also minifies `updateContent`. The fix acquires the prototype from
a **live instance**: on the first assistant message (`message_start` /
`message_update`) it walks the running component tree from the captured TUI
handle, **duck-types** an `AssistantMessageComponent` (`updateContent` +
`contentContainer` + a thinking-block setter — never an `instanceof` against
an imported class), takes `Object.getPrototypeOf(instance)`, and installs
there. The leading `Spacer` is likewise **duck-typed** (numeric `lines` +
`setLines`/`render`, not a container), and the fingerprint is
**whitespace-normalized** so it matches both the readable `dist` and the
minified bundle. Acquisition retries on each assistant message until it
succeeds, then latches once per session. The first message's pre-patch
leading blank is removed **retroactively** from that instance.

- **Check it live:** run `/activity-patch` in the pane — it prints the patch
  status (`active`, or `inactive (<reason>)`), so a false negative is visible
  immediately instead of silent.
- **What it does:** after pi builds a message's content tree, it removes the
  leading `Spacer(1)` **only** for a message whose only visible raw content is
  the thinking we already suppress. It edits the **render tree**, never the
  stored/resent message — so the byte-identical-context constraint that
  forbade `message_end` still holds. Messages with visible text keep their
  normal paragraph spacing; tool-only and empty `[]` messages were already 0
  rows.
- **Feature detection:** the patch installs only when the compiled pi
  `updateContent` still carries the exact leading-Spacer shape it targets. If
  pi changes that method, the fingerprint stops matching and the patch **fails
  open**: nothing is wrapped, the blanks return, the extension keeps working,
  and a single notification warns you to re-check the patch (`/activity-patch`
  then reports `inactive (shape-drift)`). It is idempotent, reversible
  (restored on `session_shutdown`), and crash-safe (the original method always
  runs; the patch's own work is `try`/`catch`ed).
- **⚠️ After ANY pi or extension update**, re-run `node --test test/*.test.ts`
  (the patch-controller and patches suites exercise the fingerprint match and
  the fail-open/drift path against pi's real shipped component) and confirm
  `/activity-patch` still reports `active` in a live session. A `shape-drift`
  result means pi's `updateContent` changed shape and the fingerprint in
  `src/patches.ts` needs a look.

### Surviving compaction & resume

The card is appended **early** (live, on the first tool) and mutated in
place, but `appendEntry` serializes the entry's data **once at append time**.
So the on-disk line captures the empty live snapshot
`{live:true, workedMs:0, entries:[]}`; the later settle only reaches disk if a
full file rewrite runs (migration / branch / fork), which a plain `/resume`
does not trigger. Three layers keep the card correct anyway:

1. **In-memory registry preferred over the persisted snapshot.** The renderer
   uses the model object it holds in memory rather than the entry's persisted
   `data`; in-process the two are the same object by reference, but we do not
   rely on that — only a fresh-process resume misses the registry.
2. **Compaction survival.** A compaction drops every entry before its
   `firstKeptEntryId` from the rebuilt transcript, so a card appended earlier
   in the response vanishes. On `session_compact`, if the last card entry did
   not survive into the kept context it is **re-appended** once (deduped per
   response).
3. **Graceful stale render.** When rendering from a persisted snapshot on a
   fresh process, `live:true` is treated as **settled** — never a ticking
   ghost — and an unrecorded duration shows `Worked for —` instead of a bogus
   `Worked for 0s`.

### Click-to-toggle (on by default; disable with `--no-activity-mouse`)

By default a left-click on an activity card acts on the node it lands on —
the header (full-collapse ↔ default), a group row (toggles its members), or a
member / thought row (opens its **floating modal**) — resolved through the
row-map the shaper returns. Pass `--no-activity-mouse` to turn this off (the
`Ctrl+Shift+A` cycle still works; modals then open only via a future keyboard
path — today they are click-opened).

**Hover highlighting** rides the same path: moving the mouse over a clickable
row bolds it and emphasizes its chevron. It uses any-motion tracking (`1003h`),
which raises input traffic (a report per cell the cursor crosses, bounded by
rendering only when the hovered row changes); the selection trade-off below is
unchanged.

```sh
pi --no-activity-mouse         # or add to your settings' default flags
```

**The trade-off.** pi's regular (default) renderer does not route mouse
events to components — the terminal owns its scrollback and selection. To
catch clicks the extension turns on the terminal's own mouse-reporting escape
codes (SGR button tracking, `1000h`/`1006h`), parses the click packets
itself, and replays them into pi's retained component tree. While mouse
reporting is on, **the terminal hands clicks/drags/wheel to the app instead
of doing its own thing**, so:

- Plain click-drag **text selection is intercepted.** Hold **Shift** (most
  terminals) or **Option** (iTerm2 / macOS Terminal) to force native
  selection.
- **Wheel scroll** may be affected in some terminals.

If the intercepted selection gesture bothers you, add `--no-activity-mouse`.
**`Ctrl+Shift+A` always works regardless** — it is the fallback and cycles the
newest card's state. In pi's experimental **fullscreen** renderer, mouse
events are routed natively (via each card's `MouseRegion`), so clicking works
there without any escape codes and without the selection trade-off.

The escape codes are torn down (`1000l`/`1006l`) and the input listener
removed on `session_shutdown`, restoring the terminal's normal mouse
behavior.

### Output & Thinking modals

Clicking a member row (with output) or a thought row opens a **floating
overlay** via `ctx.ui.custom(factory, { overlay: true, overlayOptions: {
anchor: "center", width: "80%", maxHeight: "80%" } })` instead of rendering
an inline ASCII box. The overlay is a focused component: `↑`/`↓`/`PgUp`/
`PgDn`/`Home`/`End` scroll, `c` copies the untruncated raw text (via pi's
exported `copyToClipboard`), and `Esc`/`q` close. Only one modal is open at a
time — opening another row hides the current handle and shows the new
content; the handle is also hidden on teardown so no overlay outlives its
card.

The modal shows the **full** output, not the ~8-line inline tail: the whole
tool-result text is captured per call (bounded to 64KB in memory), and when a
shell command truncated its own output to a temp file the modal reads that
file (`BashToolDetails.fullOutputPath`, surfaced on the `tool_result` event)
lazily on open. The content model (title, badge, caption, body, copy text)
and the scroll window math are pure and unit-tested in `src/modal.ts` /
`test/modal.test.ts`.

## Type-check

There is no local `tsc`; the repo resolves the pi types from the globally
installed pi package via `tsconfig.json` `paths`/`typeRoots`. Use any `tsc`
≥ 5, e.g. via `npx`:

```sh
npx -y typescript@5 tsc -p tsconfig.json
```

## Test

```sh
node --test test/*.test.ts
```

## Layout

- `src/index.ts` — the extension entry point: flag/command/renderer/shortcut
  registration, per-response ledger + grouper wiring, event handlers, the
  live-and-settle activity card (appended early, mutated in place, frozen at
  settle), a zero-line widget that captures the `tui.requestRender()` handle,
  and the regular-mode mouse dispatch (SGR packet parsing + synthesized
  click/hover dispatch + row-map resolution). Delegates cohesive subsystems to
  the controllers/views below.
- `src/patch-controller.ts` — `PatchController`: the guarded leading-Spacer
  patch lifecycle (lazy live-instance acquisition, `/activity-patch` status,
  teardown). State machine unit-tested in `test/patch-controller.test.ts`.
- `src/modal-controller.ts` — `ModalController`: the output/thought modal
  lifecycle (open / swap / copy / close / teardown) with an injected modal
  factory. Unit-tested in `test/modal-controller.test.ts`.
- `src/modal-view.ts` — the `OutputModal` overlay component + badge/truncate
  chrome.
- `src/card-build.ts` — pure grouper-entries → card-data conversion
  (`buildCardEntries`/`toShapeItem`) + the pure `settleAction` decision.
  Unit-tested in `test/card-build.test.ts`.
- `src/styling.ts` — pure theme-styling helpers (`styleTone`/`styleLine`)
  shared by the card renderer and the modal.
- `src/patches.ts` — the guarded runtime patch mechanics: pure,
  pi-import-free `onlyVisibleThinking` + `matchesLeadingSpacerShape`
  (whitespace-normalized, matches dist + bundle) + duck-typing
  (`isLeadingSpacer`, `isAssistantMessageComponentLike`) + a live-tree walk
  (`findAssistantMessageComponents`) feeding `acquireLeadingSpacerPatch`,
  which derives the LIVE prototype from a real instance and installs a
  feature-detected, fail-open, reversible patch. Headless-tested in
  `test/patches.test.ts`.
- `src/modal.ts` — pure modal-content model + scroll windowing for the
  floating output/thinking overlay: `itemModalContent` / `thoughtModalContent`
  (title + badge + caption + body + copy text) and `clampScrollTop` /
  `visibleSlice` / `scrollHint`. Pi-import-free, unit-tested in
  `test/modal.test.ts`.
- `src/card-shape.ts` — pure render-shaping: turns a plain card model + per-node
  expansion into ordered styled lines **and a parallel row-map** (header,
  group rows, member rows; full-collapse state; openable-row chevrons;
  calm-failure rules). Headless-tested.
- `src/grouping.ts` — pure group-boundary state machine.
- `src/mouse.ts` — pure SGR mouse-packet parser.
- `src/labels.ts` — pure, typed group-label heuristics with two upgrades: a
  per-tool label map for self-describing custom/MCP tools, and `cd`/`export`
  wrapper unwrapping for bash commands.
- `tsconfig.json` / `package.json` — type-check + install scaffolding.

## License

MIT
