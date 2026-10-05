# Muse Bridge

Talk to your Muse personal agent from [Pi](https://github.com/earendil-works/pi).

Muse Bridge pairs your computer with your Muse as a gadget and makes Muse available in Pi as a model. Pick it with
`/model` and talk to Muse right in your terminal, with your Muse's memory, knowledge and abilities.
When you want Muse to work on the files in front of you, a second model lets it drive Pi's own coding tools.

The bridge is built on Muse's official [Gadget SDK](https://gadgets.muse.ai/): it pairs, connects and chats exactly
the way the SDK's own gadgets do, and uses no undocumented features.

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [How it works](#3-how-it-works)

---

## 1. Overview

Muse Bridge is a Pi extension. It adds a provider, **`muse`**, with two models:

| Model | What it is for | What travels to Muse |
|---|---|---|
| **`muse/muse-chat`** ("Muse") | Talking to Muse: questions, ideas, planning, anything you would ask it in the app | Your messages, exactly as you type them. Muse's reply streams back as it writes |
| **`muse/muse-coding`** ("Muse (coding)") | Letting Muse work on the project you started Pi in, through Pi's tools | Pi's instructions and tool list, then tool results. Muse answers each step with one tool call or a final answer |

```
 you ──▶ Pi ──▶ Muse Bridge (this computer, paired with your Muse as a gadget)
                  │
                  │  end-to-end encrypted link (Gadget SDK protocol)
                  ▼
                your Muse ──▶ one side chat per Pi session and model
```

- Each Pi session gets its own Muse side chat for each model. Your main Muse chat is never used.
- You can switch between the two models within one session with `/model`. Each side learns what was said on the
  other.
- Pi's own features keep working: `/compact`, `/new`, forks, session resume, and in coding mode Pi's tool
  confirmations.

---

## 2. Installation

### Requirements

- [Pi](https://github.com/earendil-works/pi) (developed against 0.85.1) and Node.js 22.18 or newer
- macOS with Bluetooth, and Apple's Command Line Tools (`xcode-select --install`), used once to build the small
  Bluetooth helper that pairing needs (pairing on Linux is planned, see [TODO.md](TODO.md))
- A Muse account and the Muse app on your phone

### Step 1: install the extension

```bash
pi install git:github.com/finik/pi-muse-bridge
# over SSH:  pi install git:git@github.com:finik/pi-muse-bridge
```

Or from a local clone, either of:

```bash
pi install /path/to/pi-muse-bridge                                   # as a Pi package
ln -s /path/to/pi-muse-bridge ~/.pi/agent/extensions/musebridge      # as a linked folder
```

To try it for one run without installing: `pi -e /path/to/pi-muse-bridge/musebridge.ts`.
Restart Pi after installing. Check that it is registered:

```bash
pi --list-models muse          # shows muse/muse-chat and muse/muse-coding
```

### Step 2: create a Gadget SDK token

1. Open https://gadgets.muse.ai/settings/sdk-tokens and sign in with your Muse account.
2. Create a token and copy it. It starts with `mgst_`. Keep it private: it lets a device join your Muse.

### Step 3: pair this computer with your Muse

Muse Bridge signs in through Pi's own `/login`; it adds no commands of its own.

1. In Pi, type `/login`, choose **Sign in with an account**, then choose **Muse Bridge**.
2. Paste the SDK token from step 2 when asked.
3. The first time, Muse Bridge builds its Bluetooth helper (a few seconds) and macOS may ask whether your terminal
   may use Bluetooth. Allow it.
4. When Pi says it is ready, open the Muse app on your phone: **Settings → Devices**, turn on **Developer mode**,
   tap **Add Device**, choose **MuseGadgetXXXXXX** (the name Pi shows), continue past the community-device notice
   and pick the network it offers. No password is needed: the computer already has a network, and the step only
   completes the pairing.
5. Pi confirms with *Paired as "Muse Bridge (your-computer)"*.

The computer may not show up in the Muse app's device list after pairing. That is fine: the bridge works either
way.

Pi stores the device credentials and renews them by itself. If the pairing is removed in the Muse app, or the SDK
token is revoked, a turn ends with a message asking you to pair again. Repeat this step.

### Step 4: use it

Talk to Muse:

```bash
pi --model muse/muse-chat      # or start Pi and pick "Muse" with /model
```

Let Muse work on a project with Pi's tools:

```bash
cd ~/work/my-project
pi --model muse/muse-coding
```

The first coding message of a session is the slowest: it carries Pi's instructions and tool list to Muse.

### Troubleshooting

- **The phone doesn't list the computer:** check that Bluetooth is on, that your terminal app is allowed under
  **System Settings → Privacy & Security → Bluetooth**, and that Pi still shows the "ready to pair" message (it
  stays ready for 10 minutes). Then close and reopen the Add Device screen in the app.
- **Building the Bluetooth helper fails:** install Apple's Command Line Tools with `xcode-select --install`, then
  run `/login` again.
- **A turn says your Muse is asleep:** Muse suspends your agent when it has been idle, and a paired computer
  can't wake it. Open the Muse app on your phone (sending any message there works), then send your message in Pi
  again. Muse Bridge waits up to a minute for it to wake before giving up.
- **A chat turn waits and then says Muse needs your approval:** some things Muse does (such as opening a website)
  need your approval, which only the Muse app can give. Approve it there, then send your message again.
- **A turn says to pair again:** run step 3 again. The computer keeps its device name, so this replaces the old
  pairing rather than adding a second device.
- **The computer is not in the Muse app's device list:** nothing to fix. A paired computer does not always show
  up there, and the bridge works either way.
- **Something else:** start Pi with `MUSEBRIDGE_DEBUG=1` and read `~/.pi/agent/musebridge/debug.log`.

### Configuration

All optional, set as environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `MUSEBRIDGE_WAIT_SECONDS` | `900` chat, `300` coding | How long to wait for Muse's reply before ending the turn with an error |
| `MUSEBRIDGE_WAKE_WAIT_SECONDS` | `60` | How long to wait for a sleeping Muse to wake before ending the turn |
| `MUSEBRIDGE_IDLE_CLOSE_MS` | `120000` | How long the connection to Muse stays open after the last turn |
| `MUSEBRIDGE_DENY_DIRS` | none | Extra folders, colon separated, in which `muse/muse-coding` will not start |
| `MUSEBRIDGE_DEBUG` | off | `1` writes a debug log to `~/.pi/agent/musebridge/debug.log` (event types and truncated payloads) |

---

## 3. How it works

### 3.1 Built on the Gadget SDK

Muse Bridge is a Muse gadget, like the ones the [Gadget SDK](https://gadgets.muse.ai/) builds. It implements the
SDK's protocols in TypeScript and uses only what the SDK itself uses:

| Step | What the bridge uses |
|---|---|
| Pairing | The SDK's Bluetooth pairing protocol (version 5), confirmed from the Muse app |
| Credentials | The device tokens pairing hands over, renewed with `/device_token/refresh` |
| Connecting | `/fetch_vms` to find your Muse, then the SDK's encrypted Noise link and `link.register` on `/link-control` |
| Talking | `/chat/stream` to send a message to a side chat, `/chat/subscribe` to follow Muse's reply as it is written |

The computer registers with no device commands, so Muse can't run anything on it through the link. In coding mode
all work on your files goes through Pi's tools.

### 3.2 Pairing and credentials

- **Pairing (Bluetooth).** `/login` starts a small Bluetooth helper (`muse/ble-helper.swift`, compiled on first use
  into `~/.pi/agent/musebridge/bin/`). The helper only advertises the device and relays raw packets; the pairing
  protocol lives in `muse/pairing.ts`. The phone and the computer agree on a key (P-256 ECDH and HKDF), and every
  record after that is encrypted with AES-GCM. The phone vouches for the SDK token and hands over device
  credentials, which Muse Bridge verifies with Muse before it reports success.
- **Registration.** Right after pairing, the computer connects and registers itself as a device of your Muse.
- **The link.** Every turn travels over a WebSocket to your Muse, encrypted end to end with a Noise
  (`Noise_XX_25519_AESGCM_SHA256`) channel that carries HTTP-style requests in protobuf frames (`muse/noise.ts`,
  `muse/link.ts`, `muse/ws.ts`).
- **Credentials.** Pi's `auth.json` holds the device's access and refresh tokens and the SDK token, which Pi
  renews through Muse Bridge before they expire. The device identity is in `~/.pi/agent/musebridge/identity.json`,
  and `device.json` holds the endpoints (no secrets). Tokens are never logged or included in error messages.
- **Connection.** One Pi process keeps one connection, opened on the first turn and closed after
  `MUSEBRIDGE_IDLE_CLOSE_MS` without turns. If your Muse is asleep, the bridge waits for it to wake (see
  [Troubleshooting](#troubleshooting)).

### 3.3 One Muse side chat per Pi session and model

The first turn of a Pi session creates a dedicated Muse side chat and records the mapping
*Pi session and model → Muse side chat* in `~/.pi/agent/musebridge/state.json` (mode 600). The mapping survives
restarts, so resuming a Pi session continues in the same chats. Two Pi sessions never share a chat, and the main
Muse chat is never touched. A gadget can't list or archive chats, so a chat Muse Bridge stops using (after `/new`,
for example) is simply left as it is.

Chat and coding keep separate side chats, so the coding protocol never leaks into a conversation. When you switch
models mid-session, the other side is told what happened in between: the coding chat gets your chat messages and
Muse's chat replies as plain context, and the chat gets your messages and Muse's final coding answers, without
the tool traffic.

### 3.4 `muse/muse-chat`

- Your messages go to Muse exactly as you type them. Nothing is added: no system prompt, no protocol, no tool
  list. Muse answers the way it does in the app, with its own memory and abilities.
- The only exception is a model switch (see [3.3](#33-one-muse-side-chat-per-pi-session-and-model)): a chat
  started after you used `muse/muse-coding` opens with `[Our conversation so far, from Pi]` and the earlier messages,
  and final answers given in coding mode in between are passed on as `[Your reply in coding mode] …`.
- Muse's reply streams into Pi as it is written; when Muse answers in several messages, they appear one after
  another.
- Muse keeps the conversation in its side chat, so each turn sends only your new message. After `/compact`, only
  the newest message is sent, into the same chat.
- Pi offers its tools to every model, but chat mode never calls them.
- Some things Muse does need your approval in the Muse app. If a turn runs out of time while an approval is
  waiting, the error says what is waiting.

### 3.5 `muse/muse-coding`

In coding mode Pi owns the loop and every side effect, and Muse owns nothing but the next decision. Muse can only
*ask* for one of Pi's tools, and Pi runs it exactly as it would for any other model, including Pi's own
confirmations.

**The first message.** A new coding chat starts with one message that carries:

1. **Pi's system prompt**, the same one Pi gives any model (shortened only if it would not fit in a message).
2. **The protocol** (`[PI BACKEND MODE]`): follow Pi's system prompt, but the protocol wins where they conflict;
   do not use Muse's own tools, memory, browser tasks, sub-agents or device commands, since the user's files are
   reachable only through Pi's tools; reply with exactly one JSON object; one tool call per reply.
3. **Pi's tool schemas**, so Muse knows which tools exist and what arguments they take.
4. **Your message.**

This is sent again only when a fresh coding chat starts (after `/new`, or when the chat has to be resynced).

**One reply, one JSON object.** Muse works one step per reply, and a task takes as many steps as it needs: Pi runs
each requested tool and sends back the result, until Muse gives its final answer.

```json
{"type":"tool_call","name":"<a tool Pi offered>","arguments":{ ... }}
{"type":"final","text":"<answer for the user>"}
```

Replies are parsed defensively: Muse Bridge takes the first complete JSON object in the text (code fences and stray
prose are tolerated) and checks that `type` is `tool_call` or `final`, that the tool is one Pi currently offers,
and that the arguments validate against its schema with the validator that ships with Pi. An invalid reply gets
**one** repair message listing the exact errors; a second one ends the turn with a clear error. A call that failed
validation is never executed.

**Delta-only turns.** After the first message, each turn sends only what Muse has not seen: a new user message as
plain text, or a tool result as `{"type":"tool_result","name":"…","ok":true,"content":"…"}` (`ok:false` with an
`error` field when the tool failed). Every follow-up starts with a one-line reminder of the protocol:
`[Pi protocol: reply with exactly one JSON object, no prose, no code fences]`. If Pi's tool
set changes mid-session, the new schemas are sent as a `[PI TOOLS UPDATE]` block. Muse Bridge tracks how much of
Pi's context the chat already holds (a count plus a fingerprint of the last message sent), and resynchronises when
the two sides no longer match:

| Event in Pi | What Muse Bridge does |
|---|---|
| `/compact` | Sends a `[PI CONTEXT RESYNC]` message with the compacted context into the **same** chat |
| `/new`, a fork, or any context that no longer matches the chat | Starts a **new** chat, primes it, and sends the current context |
| Abort, timeout, or an error after a message was sent | The next turn starts a fresh chat: Muse may already have seen a message Pi will resend |
| Resume after restarting Pi | Reuses the recorded chat |

**Message size.** Every outgoing message is kept under 200,000 bytes (UTF-8 JSON), and a single tool result under
100,000. Anything longer is cut in the middle, keeping head and tail, with an explicit
`[... N characters truncated by Muse Bridge ...]` marker. When the priming text and the first request cannot share
a message, they are sent as two. Resync messages keep the newest items whole and clip or drop older ones.

**Working-directory guard.** Coding mode keeps to project folders: it does not start when Pi's working directory
is your home directory itself, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.pi`, or anything listed in
`MUSEBRIDGE_DENY_DIRS` (compared after resolving symlinks). Chat mode never touches files and runs anywhere.

### 3.6 Waiting for Muse's reply

Each turn sends one message and follows Muse's answer on the side chat's live event stream, as the SDK's gadgets do:

- Reply text arrives as it is written (`delta.text_append`) and each message is confirmed when complete
  (`delta.message_done`). `task.status` says when Muse has finished.
- The turn ends when Muse has finished and every message is complete. If the final status never arrives, it ends
  once Muse is idle, every message is complete, and nothing has happened for a few seconds.
- A side chat exists only once its first message is sent, so a new one is subscribed to right after sending, and
  an existing one before. Muse replays a chat's latest status on subscribing; that replay never ends a turn.
- If the connection drops mid-reply, the turn ends with a clear error and the next one reconnects.
- Authentication failures end the turn with a message asking you to pair again. Waiting is bounded by
  `MUSEBRIDGE_WAIT_SECONDS`, and an abort stops it immediately.

### 3.7 How it appears in Pi

- **Models:** provider `muse`, models `muse-chat` and `muse-coding`, text input, no reasoning mode, `contextWindow: 225000`
  (below Muse's own compaction point, so Pi compacts first) and `maxTokens: 8192`.
- **Streaming:** chat replies stream as Muse writes them. In coding mode a final answer is passed to Pi as text and
  a tool call as one tool-call event with fully parsed arguments; each step is one round trip, typically 3 to 15
  seconds.
- **Usage:** Muse reports no token counts, so Muse Bridge reports an estimate (characters ÷ 4) to let Pi's
  compaction trigger at the right time. Cost is always zero.

### 3.8 Layout, state and tests

```
musebridge.ts          the extension: provider, both models, side chat mapping, turns, login
muse/link.ts           the device link: VM lookup, token refresh, registration, chat send and subscribe
muse/noise.ts          Noise XX handshake, transport encryption and protobuf framing
muse/ws.ts             a minimal WebSocket client
muse/pairing.ts        Bluetooth pairing protocol and device identity
muse/ble-helper.swift  macOS Bluetooth peripheral that relays pairing packets
package.json           Pi package manifest (`pi.extensions`) and peer dependencies on Pi's libraries
test/run.mjs           test harness
test/fake-muse.mjs     stand-in for Muse's chat event stream that can drop, delay, split or reject replies
test/pi-fixture.json   a sample Pi system prompt and tool list
```

Runtime files in `~/.pi/agent/musebridge/`: `state.json` (session mapping), `identity.json`, `device.json`, `bin/`
(the compiled helper) and, with `MUSEBRIDGE_DEBUG=1`, `debug.log`.

```bash
npm install     # fetches Pi's libraries, which the tests import
npm test        # runs every scenario
```

The scenarios cover chat turns (plain words in, streamed replies, several messages, follow-ups, approvals,
compaction, aborts), switching between the two models in one session, and for coding mode plain, empty and long
replies; single and sequential tool calls; tool errors; malformed, fenced and schema-invalid replies with the
repair path; replies still being written; abort, timeout, dropped connections and missing final statuses;
`/compact` resync, `/new` and resume; oversized and Unicode content; the working-directory guard; and tool-set
changes. They also cover login and token refresh, a sleeping Muse, the Noise channel against an independent
responder, and the whole Bluetooth pairing exchange against an independent phone implementation.

---

## License

MIT, see [LICENSE](LICENSE), except the files ported from the Muse Gadget SDK (`muse/noise.ts`, `muse/link.ts` and
`muse/pairing.ts`), which remain under the Apache License 2.0, see [LICENSE-APACHE](LICENSE-APACHE).

**Disclaimer. Muse Bridge is an independent project. It is not made or endorsed by Meta. It was built without any
internal knowledge of Muse, and its functionality is based entirely on Muse's public
[Gadget SDK](https://gadgets.muse.ai/): it uses only the protocols and interfaces the SDK itself uses, and no
undocumented or reverse-engineered features. To the best of the author's understanding, it conforms to the
[Muse Terms](https://muse.ai/terms) and the [Gadget SDK Terms](https://gadgets.muse.ai/sdk-terms) as published at
the time of its release (October 2026). Those terms may change, and you are responsible for your own use of Muse
and of your SDK token. The software is provided "as is", without warranty of any kind, and the author accepts no
liability for any consequences of its use (see [LICENSE](LICENSE)).**
