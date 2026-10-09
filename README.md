# dsh-session-inherit

[English](README.md) | [简体中文](README.zh-CN.md)

Hand a long-running session off to a **clean new session**.

The session row's "…" menu gains an **Inherit** entry. Click it → preview a handoff
document mechanically extracted from the source session → confirm → a new session is
created without the old history, and that handoff is sent as its first message. Work
continues there. The source session is left untouched.

```
Pin           ← stock DSH
Rename        ← stock DSH
Fork          ← stock DSH
Inherit       ← this plugin (order 350)
Archive       ← stock DSH
```

All four rows other than "Inherit" ship with DSH itself — they are the official entries
of the `sidebar.workspaces.session.menu.item` slot. If you have other session-menu plugins
installed, their entries appear here too; this plugin owns only the "Inherit" row.

---

## Why not /compact, and not "Fork"

DSH already has two ways to keep going. This is the third:

| Approach | What it carries over | Why it does not fit |
|---|---|---|
| `/compact` | Replaces history with a summary; same session | Measured: after compressing 541,227 tokens down to 25,602, degeneration **recurred within 4 steps** — and the repeated token changed from "做。" to "好。". Length is not the cause, and neither is the content of the context |
| Official **Fork** | Copies the source session's whole history prefix | Carries the trigger along with it; the new session opens on hundreds of thousands of tokens of history |
| **Inherit (this plugin)** | Only **verifiable concrete anchors**; no history at all | The new session's context starts at a few thousand characters |

## Why no LLM summary

The `/compact` evidence was direct: the summary kept **abstract intentions** such as
"needs acceptance testing, needs a report written", and dropped exactly the **concrete
anchors** — file paths, next-step parameters. Holding a vague intention, the model kept
telling itself what to do at the abstract level, using almost the same sentence every
time — which is itself fuel for repetitive degeneration.

So this plugin's handoff document **makes zero model calls**. It only performs mechanical
extraction: the original task statement, recent user instructions (verbatim, not
rewritten), files touched, commands run, the last todo state, and the source session's
final reply. Every line can be traced back to the source session for verification.

The handoff also hard-codes three rules at the top:

> Do not restate this document. Do not summarize it. Do not reply "got it / understood".
> Read it and go straight to the "next step". Take exactly one concrete action first,
> then stop and report; do not branch out in several directions at once.

## What the handoff looks like

```
📋 会话继承单

> 来源：`session-xxx`（标题） · 共 15 轮 · 最后活动 2026-10-08 19:37
> **执行规则**：不要复述本单…

## 1. 任务目标              ← 源会话第一条真实用户消息
## 2. 最近的用户指令（由旧到新）  ← source.kind === 'user' 的原话
## 3. 涉及的文件（绝对路径）      ← 带出现次数，按最近使用排序
## 4. 项目内相对引用             ← 工具参数里的相对路径片段
## 5. 最近执行的命令
## 6. 待办（源会话最后一次 todo 状态）
## 7. 源会话最后一次回复
## 8. 下一步                    ← 你在预览框里写
```

The document is emitted in Chinese — the block above is its literal output, and the
plugin does not translate it. Section by section: task statement / recent user
instructions (oldest first) / files touched (absolute paths, with hit counts, most recent
first) / in-project relative references / commands run / todo state / the source session's
last reply / next step (written by you in the preview box).

Section 2 accepts only `source.kind === 'user'`. In one real session, 27 of its 42
`user/message` events were runtime injections — `agent-instructions` / `runtime-context` /
`skill-catalog` / `time-context` / memory notices / model selection / compaction
checkpoints — all noise. They are now kept out.

## Usage

1. Hover any session in the sidebar and click the "…" at the end of the row.
   **Any session works, including cold ones** — reading goes through
   `sessionQuery.readSession` and does not activate an agent.
2. Click **Inherit**.
3. A preview opens: source session info on top (title / turns / files / commands / todos),
   the editable handoff in the middle, and a checkbox at the bottom.
4. Under `## 8. 下一步`, write what you want done next — **the more specific the better**
   (name the file, name the single action) — then click "创建并继承" (Create and inherit).

The new session opens automatically, titled `继承: <source title>`, with the same working
directory, model route, and agent preset as the source session.

The "start working immediately" checkbox is on by default: the handoff is sent through
`sessionController.prompt` as a normal user message and work begins right away. Unchecked,
it is written straight into the session log instead (`session:append`) — recorded but not
triggered, so you can say what to do once you open it.

## Installation

Not published to npm; install it straight from the repository. Edit the profile's
`package.json` — both places:

```json
{
  "dependencies": {
    "dsh-session-inherit": "link:/path/to/dsh-session-inherit"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-session-inherit"
      ]
    }
  }
}
```

`bundles` is what actually loads the plugin — listing it only under `dependencies` will
not mount it. Restart DSH afterwards.

> The desktop app manages its own profile exclusively through Electron and the global CLI
> refuses to operate on it; in that case edit that profile's `package.json` directly and
> restart.

## Version compatibility

Verified on **DSH 0.2.0-rc.2** (Windows). The plugin depends on a number of DSH internal
services and menu slot names, so a DSH upgrade can break the match. If the menu entry does
not appear, or the plugins page shows an error, check the profile's `compatibility.json`
first: on startup a profile validates each plugin's peerDependencies against
`@deepseek-ai/dsh` and `dsh-*` and skips any bundle that does not satisfy them (it logs
`skipping profile bundle`). Add the current DSH version to the allowed list in
`compatibility.json`.

## Components

- Host half `index.mjs`: registers `POST /__session-inherit/preview` and
  `POST /__session-inherit/commit` (same-origin check, loopback only)
- Client half `client.js`: registers `sidebar.workspaces.session.menu.item`
  (id `session-inherit`, order 350) and the preview dialog on `shell.overlay`

It consumes only public services: `agents` (hard dependency), `sessionQuery`,
`sessionController`, `workspaceRegistry`, `sessionTitle`, `agentPresets`,
`agentDefaultModel`, `webServer`. Everything except `agents` is looked up on demand — a
missing service degrades one feature instead of taking the whole plugin down.

## Configuration

Override in the profile's `cordis.patch.yml` (all optional):

```yaml
- id: session-inherit
  config:
    enabled: true        # false = register nothing at all
    recentUsers: 6       # how many recent user instructions to include (1–50)
    startByDefault: true # default value of the preview checkbox
    cacheTtlMs: 120000   # reuse one log read between preview and commit; 0 = no cache
```

## Known limitations

- **It does not fix decoding degeneration.** Degeneration happens while generating the
  current step — a decoding-layer problem. What this plugin does is continue in a clean
  session without the old context, removing the two triggers "long history" and "abstract
  intention". The new session's first step can still degenerate; that belongs to the
  decoding layer and is handled by a separate plugin that detects repetition during
  generation and aborts (e.g. `dsh-degen-guard`). This plugin does not touch it.
- The handoff is mechanically extracted; it will not think up your "next step" for you.
  Leave it blank and the model will ask first — deliberately.
- If the source session's first user message is a short greeting or preamble, it appears
  verbatim as the "task statement".
- Project paths containing spaces are captured in full; fragments with non-ASCII
  punctuation such as `§` are dropped.
- The handoff is capped at 14,000 characters and truncated beyond that (a real long
  session measured roughly 4,500 characters).

## Tests

```sh
node test/extract.test.mjs   # extractor pure functions (13)
node test/host.test.mjs      # host half: endpoint registration and the full preview/commit path against a fake ctx (10)
node test/client.test.mjs    # client half: module protocol, slot registration, fallback menu row, and menu → preview → confirm → commit (4)
```

## Relation to existing plugins

Existing options were surveyed before writing this; none overlaps completely:

- **[WeiYe6/dsh-session-handoff](https://github.com/WeiYe6/dsh-session-handoff)** (`dsh-session-handoff`)
  — closest match: a `/handoff` command that creates a session in the same workspace,
  injects a handoff document, and opens it. Differences: it summarizes the last N turns
  with an LLM, and it only works from a command typed in the **current** session. This
  plugin's entry point is the session row menu, it works on any session (including cold
  ones), it makes no model calls, and it moves only concrete anchors.
- **[ZhijiangTang/dsh-handoff](https://github.com/ZhijiangTang/dsh-handoff)** —
  deterministically exports a `HANDOFF.md`, but does not create a session.
- **[liangmianya/dsh-synapse](https://github.com/liangmianya/dsh-synapse)** — a visual
  session map wired by DSH's native fork relationships; the "carry all history" route.
- **`@michengai/dsh-archive-manager`** — also registers a `delete-session` entry in the
  same menu (order 500). This plugin uses order 350, so they do not conflict.

## License

MIT
