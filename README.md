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
  shows the same spinner on its group row. **Every tool's native row** — built-in
  (`read/bash/edit/write/grep/find/ls`), MCP, or from any other extension — is
  hidden the instant it mounts, so nothing ever paints outside the card (see
  [Tool-row absorption](#tool-row-absorption)); the native working message next
  to the editor mirrors the bucket counter.
- **When the response settles** — the same card settles *in place*: **only the
  header changes** to `Worked for 12s ▾` and the ticking stops — no other layout
  shift. It keeps the ordered flow of settled group rows and **expandable
  thought entries** (`· Thought 3s · <summary> ▸`), and a failure count in the
  header. There is **one card per agent response** (covering all its turns), not
  one per turn, and because it was appended early it sits above the final answer
  text. Failures stay calm (Codex-faithful): no auto-expand — the failure
  surfaces as the badge plus a `· N failed` header count. A response that was
  interrupted (stream error or user Esc) settles with a `· interrupted` marker
  instead of pretending it finished cleanly.
- **The card is an ordered top-level flow**: the card is a sequence of **Group**,
  **Thought**, and **Narration** entries in true event order — if the agent
  narrates, thinks, runs tools, thinks again, then runs one tool, the card shows
  exactly that sequence. Each Group entry is a tree: header → group rows →
  member rows. Group rows and the header expand **independently** via a chevron
  (`▸` collapsed / `▾` expanded) at the end of the row; a member row shows a
  static `▸` to mark it **openable** — every member row opens a modal now (see
  below), not just command/search tools. Three card-level states:
  **full-collapse** (everything folds behind `Worked for Xs ▸`, the answer text
  stays), **default** (group rows visible, members hidden), and members expanded
  below that. Click a **group row** to reveal its member rows — each carries a
  **tool-family glyph** (`$` shell, `▤` read, `⌕` grep, `≡` list/find, `✎`
  edit/write, `◆` generic tool) and `<target> (<duration>)`. Click a **member
  row** to open a **floating output modal** — a focused, scrollable overlay with
  the **full** output (not an 8-line tail), a title bar (`<target> (<duration>)`
  + a `✓ Success` / `Exit code N` / `✗ Failed` badge), a `$ <command>` first line
  for command tools (or an `Input:`/`Output:` section for everything else — see
  [Output & Thinking modals](#output--thinking-modals)), and a footer hint
  (`↑/↓/PgUp scroll · c copy · Esc close`). Press **c** to copy the untruncated
  raw output to the clipboard — the modal shows a brief in-place `✓ Copied`
  confirmation. Singleton groups render as the member row directly (no
  wrapper).
- **Thinking separates groups in chronological order**: thinking is a
  **top-level Thought entry** that sits between the groups it separated, never
  nested inside a group. A run of consecutive thinking spans is **coalesced
  into one** entry `· Thought 3s · <summary> ▸`, where `<summary>` is the first
  meaningful line of the kept span (captured from `message_update` thinking
  deltas, bounded ~2KB per span). Click it to open the **Thinking** modal with
  the full captured text of every span in the run (scrollable, `c` to copy).
  **Meaningful thinking** (a coalesced run totalling ≥ 1s) closes the open
  group and becomes its own entry; **sub-threshold thinking is ignored
  entirely** — it does not break a group and does not render, which absorbs the
  bursty 1–4 ms spans so tool bursts without real thinking still form one fat
  group. A run that streamed no text degrades to a bare `· Thought 3s`. pi's
  **native** thinking block is suppressed (so it never appears twice) with
  supported levers only — a markdown transformer that blanks
  `assistant-thinking` (streaming + settled) plus `setHiddenThinkingLabel("")`
  for the `Ctrl+T`-hidden placeholder. See
  [Deviations from Codex](#deviations-from-codex) for the `Ctrl+T` interaction.
  Not every provider streams thinking as reasoning prose, though — see
  [Provider tool-activity normalization](#provider-tool-activity-normalization)
  for how a provider that streams tool activity through the thinking channel
  (Cursor) is handled.
- **Intermediate text becomes narration, not a duplicate paragraph**: an
  assistant response can stream more than one text block — a short "checking
  the config next" aside before more tool calls, then the real answer. See
  [Narration folding](#narration-folding) for the full mechanism.

It uses supported pi extension APIs and **no prompt injection**. On top of
those, the extension installs **four guarded runtime hooks** that patch pi
internals it cannot otherwise reach — see
[Runtime patches](#runtime-patches) for what each one does, why, and its
fail-open behavior. All four are feature-detected, reversible where
applicable, and touch only the render tree (never the stored/resent message).

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
restarting the session — every runtime hook rebinds itself to the fresh
runtime (see [Runtime patches](#runtime-patches)), and history (absorbed tool
rows, folded narration) is re-swept on `session_start` so a reload does not
resurrect anything that was already hidden.

> The extension has no npm dependencies of its own — it imports only
> `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which the
> host provides. No `npm install` is required.

## Usage

Just use pi. The moment the agent runs its first tool, a live `⣯ Working · Xs`
card (the spinner animates with pi's working-bar frames) appears in the
transcript above the answer, rendered in its final shape and growing in place
while the tools run; nothing renders below it — every tool row lives inside
the card from its first frame. When the response ends, only the header flips
to `Worked for Xs ▾` and the ticking stops.

| Action | How |
|--------|-----|
| Cycle the **newest** card: full-collapse → default → all-expanded → back | `Ctrl+Shift+A` |
| Full-collapse ↔ default for **one** card | Click its header |
| Show/hide a group's **members** | Click the group row |
| Open the **output modal** for a member | Click the member row |
| Open the **Thinking modal** for a thought | Click the `· Thought Ns · <summary>` row |
| Open the **full-text modal** for a narration row | Click the `› <summary>` row |
| Scroll the modal | `↑` / `↓` / `PgUp` / `PgDn` / `Home` / `End` |
| Copy the modal's full raw text | `c` |
| Close the modal | `Esc` / `q` / click outside it |
| Check every runtime hook's live status | `/activity-patch` |

Clicks are on by default (disable with `--no-activity-mouse`). Member rows
list each tool call with its tool-family glyph and `<target> (<duration>)`,
e.g. `▤ Read package.json (0.4s)`, `$ Ran git log --oneline -5 (0.3s)`; every
row shows a static `▸` marking it openable. Clicking it opens a **floating
modal** with the **full** output — scrollable and copyable — instead of an
inline box: a title bar (`<target> (<duration>)` + a `✓ Success` /
`Exit code N` / `✗ Failed` badge), a `$ <command>` first line for commands (or
`Input:`/`Output:` sections for everything else), the whole output body, and a
footer hint. For a truncated command, the modal reads the untruncated output
from the shell tool's temp file (`fullOutputPath`). Failures do not
auto-expand and rows stay neutral (no red `✗`) — the modal badge carries the
failure. Only one modal is open at a time; clicking another row swaps its
content; clicking outside the modal closes it, same as `Esc`.

### Deviations from Codex

- The card header appends `· N failed` when a response contains failed calls.
  Codex shows nothing at the collapsed level; the count stays so a collapsed
  TUI card cannot hide failures entirely (one-word cost, deliberate).
- **`Ctrl+T` is neutralized.** pi exposes no component hook for thinking
  rendering, only a markdown transformer + hidden-label lever. Blanking
  `assistant-thinking` makes the thinking *text* render **zero lines**, and
  every absorbed tool row renders **zero lines** including its own spacer (the
  [tool-row hide patch](#tool-row-absorption) returns `[]` before pi's own
  render runs at all). Because the transformer blanks the shown state and the
  label blanks the hidden state, pressing `Ctrl+T` no longer reveals a readable
  native thinking block — the card's expandable Thought rows are the single
  home for thinking.

Everything is TUI-only. In `-p`/print mode the extension loads and no-ops
cleanly (print mode emits no tool events), and none of the runtime patches
below are installed (all four are gated on live TUI mode).

## Runtime patches

pi exposes no component hook for several things this extension needs, so it
installs **four guarded runtime hooks** on pi internals. All four share the
same safety shape:

- **Feature-detected or duck-typed** — never an `instanceof` against an
  imported class (pi's CLI runs a minified **bundle**; a class the extension
  `import`s is a different object than the one live components use). Identity
  is established by inspecting distinctive members/method shapes on a **live**
  instance found by walking the running component tree from the captured TUI
  handle.
- **Fail-open** — if the target doesn't look right (pi changed shape, or the
  instance isn't mounted yet), the hook simply does not install; pi's native
  behavior is untouched and the extension keeps working, just without that
  one refinement.
- **`/reload`-safe** — each hook stores its callback in a **prototype slot**
  that a fresh install always rewrites, so a `/reload`'s new runtime (new
  closures, new state) **rebinds** the existing hook instead of leaving it
  pointing at dead state. `session_start` re-runs acquisition/rebinding with a
  short retry back-off, since the live tree may not be mounted yet.
- **Render-only** — every hook edits what gets drawn, never the
  stored/resent message. This preserves the byte-identical-context constraint:
  pi mutates the finalized message in place for the provider-resent /
  persisted context, so anything that touched *that* would break resend and
  drop `thinkingSignature`.

Check every hook's live status at once with `/activity-patch`.

### 1. Leading-spacer patch (`AssistantMessageComponent.updateContent`)

Eliminates the empty gap the markdown-transformer thinking suppression leaves
behind. `AssistantMessageComponent` adds a `Spacer(1)` around thinking runs
computed from the **raw, pre-transform** message content — a **leading** blank
whenever the message has any visible raw content (including thinking), and a
**trailing** blank after each thinking run when visible content follows. Once
the transformer blanks the thinking body to zero rows, both become pure dead
space — a `[thinking, toolCall…]` message left one leading blank (a big task
emits dozens of such messages, so they stack additively), and a
`[thinking, text]` answer left two blanks above the text.

The patch strips every dead spacer around a suppressed thinking run, on any
message shape: after pi builds the content container, it measures each
child's rendered height and removes the `Spacer`s that no longer separate two
visible blocks, keeping exactly **one** leading margin when a real
text/markdown block renders. So `[thinking,text]` collapses to the same single
margin a plain `[text]` answer has, and `[thinking,tool]` drops to zero. Real
paragraphs keep their normal spacing untouched.

**Feature detection:** the patch installs only when the compiled pi
`updateContent` still carries the exact leading-Spacer shape it targets
(a whitespace-normalized source fingerprint, so it matches both the readable
`dist` build and the minified bundle). If pi changes that method, the
fingerprint stops matching and the patch fails open — `/activity-patch`
reports `inactive (shape-drift)`.

**⚠️ After ANY pi or extension update**, run `node --test test/*.test.ts` (the
patch-controller and patches suites exercise the fingerprint match and the
fail-open/drift path against pi's real shipped component) and confirm
`/activity-patch` still reports `active` in a live session.

### 2. Tool-row absorption (`ToolExecutionComponent.render`)

See [Tool-row absorption](#tool-row-absorption) below.

### 3. Tool-mount hook (`Container.prototype.addChild`)

Closes the last timing gap in absorption: even with an id in the `absorbed`
set the instant `tool_execution_start` fires, pi's own UI handler can mount
the component and schedule a render **before** that event handler runs, and
the very first tool of a fresh session has no live instance to acquire hook 2
from until one already exists. This hook wraps `Container.prototype.addChild`
(defined once, shared by every container in the app, since
`TuiBase extends Container`) so the moment **any** container mounts a
tool-execution-shaped child — strictly before its first render — the callback
absorbs its id and installs/rebinds hook 2 from that very instance. No frame
is ever available for the row to paint natively.

### 4. Click-away modal close (`tui.dispatchMouseToOverlay`)

pi-tui routes a click that misses every overlay straight past the overlay
layer into the transcript; the modal never sees it, so it could not close on
an outside click. This hook wraps the **captured TUI instance's**
`dispatchMouseToOverlay` (an instance property, not a prototype — this one
hook is per-session rather than bundle-shared): when a click misses every
overlay while this extension's modal is open, it closes the modal and
swallows the click so it can't also toggle whatever row happens to be
underneath. Without this method present, `Esc`/`q` keep working exactly as
before — this hook only adds the outside-click convenience.

## Tool-row absorption

**Every** tool's native row — built-in (`read/bash/edit/write/grep/find/ls`),
MCP, cursor-sdk, or anything any other extension registered — is hidden by one
guarded prototype patch on pi's `ToolExecutionComponent.render`
(hook 2 above), driven by a shared `absorbed` set of tool-call ids. An id
enters the set at **mount time** (via the [tool-mount hook](#3-tool-mount-hook-containerprototypeaddchild),
hook 3) — strictly before the component's first render — so a native row never
paints even a single frame, not even for the first tool of a session.
`tool_execution_start`/`tool_execution_end` also add to the set as a fallback,
and `session_start` re-absorbs every historical row after a `/reload` (a
fresh runtime's `absorbed` set starts empty).

This extension registers **no tools of its own** — an earlier version did
(re-registering the seven built-ins with overridden renderers), but that
mechanism was deliberately removed: pi-cursor-sdk only activates its **native
tool replay** for tool names no other extension owns, so owning those names
forced Cursor onto a degraded fallback (tool activity streamed as scrubbed
thinking-text transcripts instead of real tool events) and it hard-conflicted
with other tool-display extensions. Registering nothing means every provider
gets its best available tool-event path, and the render patch is the only
thing that ever hides a row.

## Narration folding

An assistant response can stream more than one text block before its real
answer — a short aside ("Checking the config next.") before more tool calls,
then the true final answer. Codex folds these intermediate paragraphs into the
activity card instead of leaving them as separate transcript messages; this
extension does the same:

1. Every text block is provisionally recorded as a **narration** entry in the
   card's chronological flow (`Grouper.textEnd`, `src/grouping.ts`) the moment
   it finishes streaming — it is NOT hidden yet, so short/simple responses
   still render natively and instantly with zero fold-then-unfold flicker.
2. The moment anything is known to follow it — a new tool call, a new
   thinking span, or another text block starting
   (`confirmNarrationNonFinal`, `src/index.ts`) — the pending block is
   confirmed as non-final and its **native paragraph is retroactively
   hidden** (`hideMessageTextBlock`, `src/patches.ts`): the message is
   re-rendered through whatever `updateContent` is currently bound with that
   one content block's text blanked, so it collapses to zero rows exactly
   like a suppressed thinking run (and the leading-spacer patch strips its
   bordering blank for free, since its detection is structural). The hide is
   **persistent** for the component instance's lifetime — a per-instance
   `updateContent` wrapper keeps re-applying it on every future native
   re-render, so a message that keeps streaming after the narration (more
   thinking, a second text block) cannot resurrect it.
3. At settle, `Grouper.finalize()` (`src/grouping.ts`) closes the flow: if the
   **trailing** entry is narration — nothing ever followed it — it is popped
   back out as the response's real `finalAnswer` and rendered as a normal
   native transcript message, exactly as if narration folding did not exist.
4. **Promotion**: if the response instead ends on a group or a thought (no
   trailing text — a turn that finished on tool calls, or a provider that
   trails thinking/tool-activity dumps after its real answer), `finalize()`
   scans backward for the **last** narration entry and promotes it back out
   as `finalAnswer` too, so a response is never left visibly answerless. Its
   already-hidden native block is restored (`restoreMessageTextBlock`,
   `src/patches.ts`) so it reappears as the normal answer instead of staying
   trapped inside the card.
5. **Surviving rebuilds**: a full transcript rebuild — compaction, `/resume`,
   `/reload` — recreates every message component from the **original,
   un-blanked** stored content, since the hide is render-only and never
   touches what's persisted. `rehideNarrationAfterRebuild` sweeps the rebuilt
   tree and re-hides any text block whose trimmed content matches a narration
   entry already known from a persisted card (`session_compact` handler; the
   `session_start` sweep covers `/reload`).

A narration row (`› <summary>`) renders in the theme's normal body-text
colour, not dim — it IS the assistant's own prose, just relocated into the
card, not metadata. Click it to open the full text in a modal, same as a
thought row.

## Provider tool-activity normalization

Not every provider streams tool activity as real `tool_execution` events.
Cursor (via `pi-cursor-sdk`, when its native tool replay cannot activate) runs
tools in its cloud agent and streams each one back through the **thinking**
channel as an operation dump ("`$ grep …`", "`read /path`",
"`Cursor shell: <cmd>` + output"), interleaved with genuine reasoning prose.
Left alone, those dumps would coalesce into ordinary Thought entries and the
card would show no tool members at all.

`src/span-classify.ts` is the single normalization point for this: a pure
`classifyThinkingSpan(text)` looks at a **finished** thinking span's first
non-empty line and structurally decides "reasoning" or "this is really a tool
step" (`$ …`, `Cursor <word>: …`, `read /path`, `grep/glob/list <arg>` —
never keyed to a provider name, so any other SDK that adopts the same
transcript convention is classified for free). A span classified as a tool
step becomes a **synthetic** settled call — a real card member with the
dump's first line as its label (`ToolCall.labelOverride`, `src/card-build.ts`)
and the full dump as its modal output — added to the group in exact stream
order, instead of polluting the Thought entry.

## Output & Thinking modals

Clicking a member row, a thought row, or a narration row opens a **floating
overlay** via `ctx.ui.custom(factory, { overlay: true, overlayOptions: {
anchor: "center", width, maxHeight: "80%" } })` instead of rendering an inline
ASCII box. Width is `min(80% of the terminal, 100 columns)`, floor 40 — capped
so the modal doesn't stretch full-width on wide terminals. The overlay is a
focused component: `↑`/`↓`/`PgUp`/`PgDn`/`Home`/`End` scroll, `c` copies the
untruncated raw text (via pi's exported `copyToClipboard`) and shows a brief
in-modal `✓ Copied` confirmation in the footer (never in pi's status bar), and
`Esc`/`q`/an outside click all close it. Only one modal is open at a time —
opening another row hides the current handle and shows the new content; the
handle is also hidden on teardown so no overlay outlives its card.

A tool member's modal body is sectioned: a command tool (`bash`/`powershell`)
leads with a `$ <command>` line; every other tool leads with an `Input:`
section (the call's pretty-printed arguments, when there were any) followed
by `Output:` — so an MCP/extension tool modal always shows what was actually
called, not just its result, and never opens empty (`(no output captured)`
when a call genuinely produced nothing). Modal body text renders in the
theme's normal colour, not dim — it's content the user opened to read, not
metadata; the caption/footer/borders stay dim for contrast.

The modal shows the **full** output, not the ~8-line inline tail: the whole
tool-result text is captured per call (bounded to 64KB in memory) for every
tool, and when a shell command truncated its own output to a temp file the
modal reads that file (`BashToolDetails.fullOutputPath`, surfaced on the
`tool_result` event) lazily on open. The content model (title, badge, caption,
body, copy text) and the scroll window math are pure and unit-tested in
`src/modal.ts` / `test/modal.test.ts`; the open/swap/copy/close/teardown
lifecycle is `ModalController` in `src/modal-controller.ts`.

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
   response). The same handler also re-sweeps [narration hides](#narration-folding)
   and tool-row absorption across the rebuilt tree.
3. **Graceful stale render.** When rendering from a persisted snapshot on a
   fresh process, `live:true` is treated as **settled** — never a ticking
   ghost — and an unrecorded duration shows `Worked for —` instead of a bogus
   `Worked for 0s`.

### Click-to-toggle (on by default; disable with `--no-activity-mouse`)

By default a left-click on an activity card acts on the node it lands on —
the header (full-collapse ↔ default), a group row (toggles its members), or a
member / thought / narration row (opens its **floating modal**) — resolved
through the row-map the shaper returns. Pass `--no-activity-mouse` to turn
this off (the `Ctrl+Shift+A` cycle still works; modals then open only via a
future keyboard path — today they are click-opened).

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

## Debugging

Set `PI_ACTIVITY_DEBUG=1` to dump the live component tree structure to a log
file (default `/tmp/activity-feed-debug.log`, override with
`PI_ACTIVITY_DEBUG_LOG`) at settle time — a diagnostic aid for tracking down
rendering/patch issues without instrumenting the extension by hand. Off by
default; has no effect unless set.

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
  live-and-settle activity card lifecycle (appended early, mutated in place,
  frozen at settle), the tool-absorption `Set` + its acquisition wiring, and
  a zero-line widget that captures the `tui.requestRender()` handle.
  Delegates every cohesive subsystem to the controllers/views below.
- `src/mouse-controller.ts` — `MouseController`: regular-mode mouse dispatch
  (enable/disable escape sequences, SGR packet routing via `mouse.ts`,
  synthesized click/hover dispatch into the retained tree, last-move-hit
  commit). Unit-tested in `test/mouse-controller.test.ts`.
- `src/card-view.ts` — the `ActivityCard` component + card view state
  (per-card expansion, hover state, row-map registration for click
  resolution). Unit-tested in `test/card-view.test.ts`.
- `src/narration-controller.ts` — `NarrationController`: the whole narration
  lifecycle in one place — pending capture at `text_end`, confirm-hide when
  activity follows, promotion restore at settle, rebuild re-hide sweeps.
  Orchestrates the pure pieces in `grouping.ts`/`card-shape.ts`/`patches.ts`.
  Unit-tested in `test/narration-controller.test.ts`.
- `src/card-model.ts` — persistence/model policy split out of card-shape:
  `CardModel`/`PersistedCardData`, `staleCardShapeModel`,
  `shouldReappendCard`, and the `suppressThinkingMarkdown` transformer
  decision. Unit-tested in `test/card-model.test.ts`.
- `src/patch-controller.ts` — `PatchController`: the guarded leading-Spacer
  patch lifecycle (lazy live-instance acquisition, `/activity-patch` status,
  teardown). State machine unit-tested in `test/patch-controller.test.ts`.
- `src/modal-controller.ts` — `ModalController`: the output/thought/narration
  modal lifecycle (open / swap / copy / close / teardown) with an injected
  modal factory. Unit-tested in `test/modal-controller.test.ts`.
- `src/modal-view.ts` — the `OutputModal` overlay component + badge/truncate
  chrome + the in-modal copy-feedback footer state.
- `src/card-build.ts` — pure grouper-entries → card-data conversion
  (`buildCardEntries`/`toShapeItem`, including synthetic-call `labelOverride`
  handling) + the pure `settleAction` decision. Unit-tested in
  `test/card-build.test.ts`.
- `src/span-classify.ts` — pure provider-stream normalization: classifies a
  finished thinking span as reasoning or a reconstructed tool step (Cursor's
  thinking-channel tool dumps). Unit-tested in `test/span-classify.test.ts`.
- `src/styling.ts` — pure theme-styling helpers (`styleTone`/`styleLine`)
  shared by the card renderer and the modal.
- `src/patches.ts` — all four guarded runtime patches: the leading-Spacer
  patch (`installLeadingSpacerPatch`, `matchesLeadingSpacerShape`,
  whitespace-normalized to match dist + bundle), narration
  hide/restore/rehide (`hideMessageTextBlock`, `restoreMessageTextBlock`,
  `rehideNarrationAfterRebuild`), tool-row absorption
  (`installToolRowHidePatch`, `acquireToolRowHidePatch`,
  `collectToolExecutionIds`), and the tool-mount hook
  (`installToolMountHook`). Shared duck-typing (`isLeadingSpacer`,
  `isAssistantMessageComponentLike`, `isToolExecutionComponentLike`) and
  live-tree walks feed all four. Headless-tested in `test/patches.test.ts`.
- `src/modal.ts` — pure modal-content model + scroll windowing for the
  floating output/thinking/narration overlay: `itemModalContent` /
  `thoughtModalContent` / `narrationModalContent` (title + badge + caption +
  body + copy text, including the Input/Output sectioning) and
  `clampScrollTop` / `visibleSlice` / `scrollHint`. Pi-import-free,
  unit-tested in `test/modal.test.ts`.
- `src/card-shape.ts` — pure render-shaping: turns a plain card model + per-node
  expansion into ordered styled lines **and a parallel row-map** (header,
  group/thought/narration rows, member rows; full-collapse state; openable-row
  chevrons; calm-failure rules; the `· interrupted` marker). Headless-tested.
- `src/grouping.ts` — pure group-boundary state machine, including narration
  entry recording and the finalize/promotion decision.
- `src/mouse.ts` — pure SGR mouse-packet parser.
- `src/labels.ts` — pure, typed group-label heuristics with two upgrades: a
  per-tool label map for self-describing custom/MCP tools, and `cd`/`export`
  wrapper unwrapping for bash commands.
- `tsconfig.json` / `package.json` — type-check + install scaffolding.

## License

MIT
