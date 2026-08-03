# openclaw-mattermost-ack-reaction

Adds acknowledgement and lifecycle status reactions to accepted inbound
Mattermost messages in [OpenClaw](https://github.com/openclaw/openclaw).

This is a **temporary workaround** for
[openclaw/openclaw#99277](https://github.com/openclaw/openclaw/issues/99277):
the bundled `@openclaw/mattermost` channel does not yet wire
`messages.ackReaction` / `messages.ackReactionScope` the way Discord, Slack,
Telegram, WhatsApp, Signal, and Matrix already do
([PR #80426](https://github.com/openclaw/openclaw/pull/80426) implementing
this upstream was closed without merging). Once core support ships, this
plugin should be removed.

## What it does

The plugin starts each accepted, in-scope inbound Mattermost post with the
configured acknowledgement reaction (normally 👀/`eyes`). It then correlates
public OpenClaw lifecycle hooks by the canonical `sessionKey`, falling back to
the turn's `runId` when no session key is available:

1. Resolves the effective ack-reaction emoji and scope from your existing
   OpenClaw config (`channels.mattermost.accounts.<id>.*` →
   `channels.mattermost.*` → `messages.ackReaction*`) and from
   `MATTERMOST_BOT_TOKEN` / `MATTERMOST_URL` for the default account — the
   same resolution order and env-var behavior documented in
   [`docs/channels/mattermost.md`](https://github.com/openclaw/openclaw/blob/main/docs/channels/mattermost.md)
   and [`docs/gateway/config-agents.md`](https://github.com/openclaw/openclaw/blob/main/docs/gateway/config-agents.md).
2. Normalizes the configured emoji (unicode, `:shortcode:`, or bare name) to
   a Mattermost `emoji_name`.
3. Adds the initial reaction via `POST /api/v4/reactions`, directly through the
   Mattermost REST API — it does not depend on `@openclaw/mattermost`'s
   private internals.
4. When lifecycle reactions are enabled, moves through model, tool,
   compaction, stall, and terminal states using OpenClaw's public
   `channel-feedback` status controller.

| Event/state | Mattermost reaction |
| --- | --- |
| Accepted inbound post | configured ack, normally 👀/`eyes` |
| Model call starts | 🧠/`brain` |
| Tool call | OpenClaw's public tool-category mapping (coding, web, deploy, build, concierge, or generic tool) |
| Compaction, when its hook carries the same lifecycle correlation key | 🗜️/`clamp` |
| Soft/hard inactivity stall | ⏳/`hourglass_flowing_sand` after 10 seconds, then 🗿/`moyai` after 30 seconds |
| Successful terminal run | removes plugin-tracked transients and leaves ✅/`white_check_mark` |
| Failed terminal run | removes plugin-tracked transients and leaves ❌/`x` |

Reaction writes remain non-blocking. Failures are logged and never change the
agent run result.

## Required plugin hook permission

OpenClaw classifies `agent_end` as a conversation hook. Non-bundled plugins
must explicitly opt in even though this plugin reads only lifecycle metadata
(`sessionKey`, `runId`, and `success`) and never reads the event's messages or
error text:

```json5
{
  plugins: {
    entries: {
      "mattermost-ack-reaction": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
      },
    },
  },
}
```

Without this permission, the initial acknowledgement and non-conversation
activity hooks can still run, but OpenClaw blocks terminal `agent_end`
registration, so terminal ✅/❌ cleanup is unavailable.

## Lifecycle configuration

The plugin follows the shared OpenClaw setting. Only an explicit `false`
disables lifecycle transitions and preserves the original ack-only behavior:

```json5
{
  messages: {
    ackReaction: "👀",
    ackReactionScope: "all",
    statusReactions: {
      enabled: false, // ack-only fallback
    },
  },
}
```

## Install

To install it locally:

```bash
npm install
npm run build
npm pack
openclaw plugins install npm-pack:/path/to/openclaw-mattermost-ack-reaction-0.2.3.tgz
```

## Scope semantics (`messages.ackReactionScope`)

The `message_received` hook event does not expose whether a message was a
DM, whether the bot was @-mentioned, or whether it came from a group/channel
— that data only exists on the separate `inbound_claim` event. Rather than
guess, this plugin only honors the scope values it can implement exactly:

| Scope                                    | Behavior                                            |
| ----------------------------------------- | ---------------------------------------------------- |
| `all`                                     | Reacts to every accepted inbound Mattermost message. |
| `off` / `none`                            | Never reacts.                                        |
| `group-mentions` (default), `group-all`, `direct` | **Not implemented.** Logged once as an unsupported scope, then skipped. |

If you rely on one of the unsupported scopes, set
`messages.ackReactionScope: "all"` (or a Mattermost-account-scoped
`ackReactionScope`) to get ack reactions from this plugin.

## Emoji handling

`messages.ackReaction` (default `"👀"`) is normalized to a Mattermost
`emoji_name`:

- A bare Mattermost name (e.g. `eyes`) or a `:shortcode:` form (e.g.
  `:eyes:`) is passed through as-is.
- A small, explicit set of common unicode emoji used elsewhere in OpenClaw's
  own docs is mapped to its Mattermost short name (👀→`eyes`, 👍→`+1`,
  👎→`-1`, ✅→`white_check_mark`, ❤️→`heart`, 🎉→`tada`, 🔥→`fire`,
  👏→`clap`, 🚀→`rocket`).
- Any other unicode emoji is reported as unsupported (logged once) rather
  than guessed at.
- An explicit empty string at any config level disables the reaction for
  that scope, matching the convention documented for other channels.

## Known limitations

- **Narrow scopes are not implemented** (see above) — only `all` and
  `off`/`none` are honest given the data `message_received` provides.
- **No agent-identity emoji fallback.** Other channels fall back to the
  bound agent's `identity.emoji` when no `ackReaction` is configured
  anywhere; this plugin's final fallback is a hardcoded `"👀"` instead, to
  avoid resolving agent/binding config for a narrowly-scoped workaround.
- **External-plugin delivery parity is incomplete.** Terminal reactions follow
  public agent lifecycle completion, not confirmed delivery of the final
  Mattermost reply. The external-plugin outbound path does not provide a
  universally reliable delivery settlement signal, so a later delivery
  failure can still leave ✅.
- **Attempt-boundary retry metadata is not public.** Some harnesses can emit
  `agent_end` before an automatic retry. The plugin waits one second before
  committing a terminal reaction and cancels it when model/tool/compaction
  activity resumes with the same lifecycle correlation key. A retry that
  starts after that window cannot be distinguished from a true terminal run.
- **Steered messages share the active lifecycle.** Mattermost's
  `message_received` hook currently omits `runId`, so another inbound message
  in the same session would otherwise keep its initial ack forever. Under the
  default/global/per-channel `steer` queue mode, the plugin joins that message
  to the active session controller so both reactions settle together.
- **Non-steer per-session overrides cannot be observed.** The public hook does
  not expose the final queue-admission result or a persisted per-session queue
  override. Global/per-channel `followup`, `collect`, and `interrupt` modes are
  not joined to an active lifecycle; an inline or persisted override can still
  make correlation best-effort until OpenClaw exposes that admission metadata.
- **REST cleanup is best-effort.** A failed add is not tracked or removed. A
  failed terminal delete is logged but can leave that transient reaction in
  Mattermost because the lifecycle hook must remain non-blocking.
- Mattermost removal is scoped to the bot user's exact post/emoji tuple, so
  other users' reactions are never removed. The plugin only requests removal
  for emoji it successfully tracked; Mattermost cannot distinguish a
  pre-existing identical reaction made by the same bot identity.
- In-flight run state is bounded and in memory. After 15 minutes without
  activity, non-terminal tracked reactions are cleaned back to the initial ack;
  orphan reservations are dropped. A Gateway restart clears the state.
- Duplicate REST writes for the same inbound message are suppressed for 10
  minutes (bounded, in-memory only); a Gateway restart clears that state.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

- `src/` — plugin source (TypeScript, ESM).
- `test/` — Vitest unit tests, including a hand-written `OpenClawPluginApi`
  test double (the SDK's own test-only helpers such as
  `openclaw/plugin-sdk/plugin-test-api` are repo-internal and not published
  for third-party plugins).
- `dist/` — build output; `openclaw.extensions` points here, not at `src/`.

## License

MIT
