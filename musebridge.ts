// Muse Bridge: your Muse personal agent, from Pi.
//
// This computer is paired with the user's Muse as a gadget (Muse Gadget SDK protocol, see muse/), and talks to
// the agent over the gadget's encrypted channel. Two models:
// - muse/muse-chat: a conversation with Muse. Messages go to a Muse side chat as they are; replies come back as text.
// - muse/muse-coding: Muse as the model behind Pi's coding loop. Pi runs every tool locally; for each turn Muse Bridge
//   sends the new part of the conversation and gets back one JSON object, either a tool call or a final answer.
// See README.md.
import { createAssistantMessageEventStream, createProvider, validateToolCall } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve, sep } from "node:path";
import { DEFAULT_API, DEFAULT_NOISE_HOST, eventName, eventText, fetchVms, MuseHttpError, MuseLink, refreshDeviceToken, type Vm } from "./muse/link.ts";
import { identityFrom, loadOrCreateIdentity, pairOverBluetooth, SDK_TOKEN_RE } from "./muse/pairing.ts";

// ---------- configuration ----------

const HOME = homedir();
const STATE_DIR = join(HOME, ".pi", "agent", "musebridge");
const STATE_FILE = join(STATE_DIR, "state.json");
const LOG_FILE = join(STATE_DIR, "debug.log");
const DEVICE_FILE = join(STATE_DIR, "device.json"); // this computer's gadget identity and Muse endpoints (no secrets)
const BIN_DIR = join(STATE_DIR, "bin");
const VERSION = "0.2.0";

const DEBUG = process.env.MUSEBRIDGE_DEBUG === "1";
const WAIT_ENV = Number(process.env.MUSEBRIDGE_WAIT_SECONDS) || 0;
const WAIT_MS = { coding: (WAIT_ENV || 300) * 1000, chat: (WAIT_ENV || 900) * 1000 }; // Muse's own tasks can take a while
const POLL_MS = Number(process.env.MUSEBRIDGE_POLL_MS) || 1_000; // how often a waiting turn rechecks (events also wake it)
const SETTLE_MS = Number(process.env.MUSEBRIDGE_SETTLE_MS) || 6_000;
const IDLE_CLOSE_MS = Number(process.env.MUSEBRIDGE_IDLE_CLOSE_MS) || 120_000;
const WAKE_WAIT_MS = (Number(process.env.MUSEBRIDGE_WAKE_WAIT_SECONDS) || 60) * 1000; // how long to wait for a sleeping Muse
const WAKE_POLL_MS = 3_000;
const TOKEN_LIFETIME_MS = 3 * 3600_000; // the SDK rotates device tokens once they are 3 hours old

// Muse accepts up to 256 KB per message from a device; sizes are measured as the UTF-8 JSON request body.
const FRAME_LIMIT = 240_000;
const MSG_CAP = 200_000; // any single message
const RESULT_CAP = 100_000; // one tool result
const ITEM_CAP = 3_000; // one older item inside a context resync
const TEXT_CHUNK = 160; // a final answer is replayed to Pi in chunks of this size

const REMINDER = "[Pi protocol: reply with exactly one JSON object, no prose, no code fences]";

const realPath = (p: string): string => {
  try { return realpathSync(resolve(p)); } catch { return resolve(p); }
};
const HOME_REAL = realPath(HOME);
const DENY_DIRS = [HOME, join(HOME, ".ssh"), join(HOME, ".aws"), join(HOME, ".gnupg"), join(HOME, ".pi"),
  ...(process.env.MUSEBRIDGE_DENY_DIRS ?? "").split(":").filter(Boolean)].map((d) => realPath(d.replace(/^~/, HOME)));

type Mode = "chat" | "coding";
const modeOf = (model: any): Mode => (model?.id === "muse-chat" ? "chat" : "coding");

type ErrorKind = "auth" | "muse" | "timeout" | "invalid" | "denied";
class BridgeError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

function log(tag: string, data?: unknown) {
  if (!DEBUG) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const s = typeof data === "string" ? data : JSON.stringify(data) ?? "";
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${tag} ${s.length > 300 ? s.slice(0, 300) + `…(+${s.length - 300})` : s}\n`);
  } catch {}
}

// ---------- session state (Pi session -> Muse thread) ----------

interface SessionState {
  threadId: string;
  sentCount: number; // Pi messages already reflected in the Muse thread, including our last reply
  lastFp: string; // fingerprint of the last Pi message we sent
  toolsFp: string; // fingerprint of the tool list the agent was last told about
  dirty: boolean; // a failure or abort may have left the thread diverged: the next turn starts a new one
  resync: boolean; // Pi compacted: the next turn resyncs the same thread
  updated: string;
}
interface State { sessions: Record<string, SessionState> }

function loadState(): State {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { sessions: {} }; }
}

function mutateState(fn: (all: State) => void) {
  const all = loadState();
  fn(all);
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, STATE_FILE);
}

function updateSession(key: string, fn: (s: SessionState) => void) {
  mutateState((all) => { if (all.sessions[key]) fn(all.sessions[key]); });
}

// Each Pi session has its own Muse side chat per mode, so switching models never mixes the JSON protocol into a
// conversation (or the other way round). Coding keeps the bare session key.
let currentKey: string | undefined;
const sessionKey = () => currentKey ?? `ephemeral:${process.pid}`;
const modeKey = (key: string, mode: Mode) => (mode === "chat" ? key + "#chat" : key);

// ---------- size handling ----------

// Bytes s occupies inside the JSON request body (UTF-8, with JSON escapes).
const encLen = (s: string): number => Buffer.byteLength(JSON.stringify(s), "utf8");

// Shorten `text` (keeping its head and tail) until build(text) encodes to at most `cap` bytes.
function fitMiddle(text: string, cap: number, build: (t: string) => string = (t) => t): string {
  if (encLen(build(text)) <= cap) return text;
  const cut = (n: number) => {
    const head = Math.ceil(n * 0.6);
    return text.slice(0, head) + `\n[... ${text.length - n} characters truncated by Muse Bridge ...]\n` + text.slice(text.length - (n - head));
  };
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encLen(build(cut(mid))) <= cap) lo = mid; else hi = mid - 1;
  }
  return cut(lo);
}

// ---------- the Muse connection ----------

// This computer as a Muse gadget: identity plus the endpoints Muse handed over at pairing. Written by /login.
interface DeviceInfo { mac: string; apiUrl: string; noiseHost: string; displayName: string }

function loadDevice(): DeviceInfo | undefined {
  try {
    const d = JSON.parse(readFileSync(DEVICE_FILE, "utf8"));
    return typeof d?.mac === "string" ? d : undefined;
  } catch { return undefined; }
}

function saveDevice(d: DeviceInfo) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(DEVICE_FILE + ".tmp", JSON.stringify(d, null, 1) + "\n", { mode: 0o600 });
  renameSync(DEVICE_FILE + ".tmp", DEVICE_FILE);
}

const displayName = () => `Muse Bridge (${hostname().split(".")[0] || "computer"})`;

const AUTH_MESSAGE = "Muse rejected this computer's device token (the pairing was removed or has expired). Run /login and choose Muse Bridge to pair again.";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new Error("aborted"));
    const onAbort = () => { clearTimeout(timer); rej(new Error("aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); res(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// One connection per Pi process, opened on demand and closed when idle, so the device is online while Pi works.
let link: MuseLink | undefined, linkToken = "", linkConnecting: Promise<MuseLink> | undefined, idleTimer: NodeJS.Timeout | undefined;

// Muse suspends the VM when it is idle, and a device can't wake it; opening the Muse app does. While it sleeps,
// connecting fails with a 502, so wait a while for it to come back before giving up.
const ASLEEP_MESSAGE = "Your Muse is asleep. Open the Muse app on your phone to wake it, then send your message again.";

async function connectDevice(accessToken: string, signal?: AbortSignal): Promise<MuseLink> {
  const dev = loadDevice();
  if (!dev) throw new BridgeError("auth", "This computer is not paired with Muse yet. Run /login and choose Muse Bridge.");
  const giveUpAt = Date.now() + WAKE_WAIT_MS;
  for (;;) {
    let vms: Vm[];
    try { vms = await fetchVms(accessToken, dev.apiUrl, signal); }
    catch (e: any) { throw e instanceof MuseHttpError && e.status === 401 ? new BridgeError("auth", AUTH_MESSAGE) : new BridgeError("muse", `Could not reach Muse: ${e?.message ?? e}`); }
    if (!vms.length) throw new BridgeError("auth", AUTH_MESSAGE);
    const vm = vms.find((v) => v.isDefault) ?? vms[0];
    if (vm.state !== "SUSPENDED") {
      try {
        return await MuseLink.connect({ noiseHost: dev.noiseHost, vm, device: { nodeId: identityFrom(dev.mac).nodeId, displayName: dev.displayName, version: VERSION }, signal });
      } catch (e: any) {
        if (e?.status === 401 || e?.status === 403) throw new BridgeError("auth", AUTH_MESSAGE);
        if (e?.status !== 502 && e?.status !== 503) throw new BridgeError("muse", `Could not connect to Muse: ${e?.message ?? e}`);
      }
    }
    log("vm-asleep", vm.state);
    if (Date.now() + WAKE_POLL_MS > giveUpAt) throw new BridgeError("muse", ASLEEP_MESSAGE);
    await sleep(WAKE_POLL_MS, signal);
  }
}

async function getLink(accessToken: string, signal?: AbortSignal): Promise<MuseLink> {
  clearTimeout(idleTimer);
  if (link && !link.closed && linkToken === accessToken) return link;
  if (!linkConnecting) {
    link?.close(new Error("replaced"));
    linkConnecting = connectImpl(accessToken, signal).then((l) => {
      link = l; linkToken = accessToken;
      l.onClose = (why) => log("link-closed", why.message);
      log("link-open");
      return l;
    }).finally(() => { linkConnecting = undefined; });
  }
  return linkConnecting;
}

// Tests replace the connection with a fake Muse.
let connectImpl: (accessToken: string, signal?: AbortSignal) => Promise<MuseLink> = connectDevice;
export const __test = { connectDevice, setConnect(fn: typeof connectImpl) { connectImpl = fn; link?.close(new Error("test reset")); link = undefined; } };

function releaseLink() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { link?.close(new Error("idle")); link = undefined; }, IDLE_CLOSE_MS);
  idleTimer.unref();
}

const TERMINAL = new Set(["completed", "failed", "errored", "cancelled", "canceled"]);
const MESSAGE_EVENTS = new Set(["delta.message_start", "delta.text_append", "delta.message_done", "message.assistant"]);

// Send one message to a side chat and follow Muse's answer on the chat's live event stream, the way the Gadget SDK
// does: reply text arrives as deltas and completed messages, and task.status says when Muse is done. The side chat
// belongs to this computer, so every assistant message on it after our send belongs to this turn. A new side chat
// exists only once its first message is sent, so it is subscribed to right after sending; an existing one before.
//
// In coding mode the reply is Muse's newest message. In chat mode it is everything Muse said (it may answer in
// several messages), reported through onText as it grows.
async function exchange(threadId: string, text: string, isNew: boolean, accessToken: string, signal: AbortSignal | undefined, note: { sent: boolean },
  mode: Mode = "coding", onText?: (text: string) => void): Promise<string> {
  if (encLen(text) > FRAME_LIMIT) throw new BridgeError("muse", `internal: message of ${encLen(text)} bytes exceeds the Muse message limit`);
  const dev = loadDevice()!;
  const deviceId = dev ? identityFrom(dev.mac).nodeId : "";
  const l = await getLink(accessToken, signal);

  // On subscribing, Muse replays the chat's latest status. Only events after our send count, and a finished task
  // only once it was seen running, so a replayed "completed" from the previous turn never ends this one.
  const replies = new Map<string, { text: string; done: boolean }>();
  let armed = false, running = false, finished = false, busy = false, approval = "", lastEventAt = Date.now();
  let wake: () => void = () => {};
  const current = () => {
    const texts = [...replies.values()].map((r) => r.text).filter(Boolean);
    return mode === "chat" ? texts.join("\n\n") : texts[texts.length - 1] ?? "";
  };
  const onEvent = (ev: any) => {
    if (!armed) return;
    const n = eventName(ev), p = ev?.payload ?? {};
    lastEventAt = Date.now();
    if (n === "agent.status") {
      if (p.activity_text) log("status", p.activity_text);
      if (typeof p.activity_code === "string") busy = !["", "online", "idle"].includes(p.activity_code);
    } else if (n === "task.status") {
      if (p.status === "running") { running = true; busy = true; finished = false; }
      else if (TERMINAL.has(p.status) && running) { finished = true; busy = false; }
    } else if (n === "approvals.snapshot") {
      const pending = Array.isArray(p.pending_approvals) ? p.pending_approvals : [];
      approval = pending.length ? String(pending[0]?.display?.title ?? pending[0]?.title ?? "an action") : "";
      if (approval) log("approval-pending", approval);
    } else if (MESSAGE_EVENTS.has(n)) {
      const id = p.message_id ?? ev?.message_id ?? p.id;
      if (typeof id !== "string" || !id || p.role === "user") return;
      const r = replies.get(id) ?? { text: "", done: false };
      if (n === "delta.text_append" && typeof p.text === "string" && !r.done) r.text += p.text;
      if (n === "delta.message_done" || n === "message.assistant") {
        const full = eventText(ev);
        if (full) r.text = full;
        if (n === "delta.message_done" || p.display_text_ready !== false) r.done = true;
      }
      replies.set(id, r);
      if (mode === "chat") onText?.(current());
    }
    wake();
  };

  // A chat whose first message never got through does not exist yet: then it is subscribed to after sending.
  let sub = isNew ? undefined : await l.subscribe(threadId, onEvent).catch((e) => { if (e?.status === 404) return undefined; throw e; });
  try {
    note.sent = true; // from here the agent may have the message, even if the send fails or is aborted
    armed = true;
    const ack = await l.sendChat(text, threadId, deviceId, signal);
    log("sent", { bytes: encLen(text), head: text.slice(0, 120), messageId: ack.messageId });
    if (!sub) sub = await l.subscribe(threadId, onEvent);

    const startedAt = Date.now(), waitMs = WAIT_MS[mode];
    while (Date.now() < startedAt + waitMs) {
      if (l.closed) throw new BridgeError("muse", "The connection to Muse dropped before the reply finished. Send your message again.");
      const all = [...replies.values()], allDone = all.every((r) => r.done);
      // Done: Muse finished the task and every message is complete; or, if the final status went missing, Muse is
      // idle with complete messages and nothing has happened for a while.
      if (all.length && allDone && (finished || (!busy && Date.now() - lastEventAt >= SETTLE_MS))) { log("reply", current()); return current(); }
      if (finished && !all.length && Date.now() - lastEventAt >= SETTLE_MS) { log("reply-empty"); return ""; }
      await Promise.race([sleep(POLL_MS, signal), new Promise<void>((r) => (wake = r))]);
    }
    const hint = approval ? `; Muse is waiting for your approval of ${approval} in the Muse app`
      : mode === "chat" ? "; if Muse is waiting for your approval, answer it in the Muse app" : "";
    throw new BridgeError("timeout", `No reply from the Muse agent within ${Math.round(waitMs / 1000)}s (set MUSEBRIDGE_WAIT_SECONDS to wait longer${hint})`);
  } catch (e: any) {
    if (e instanceof MuseHttpError && (e.status === 401 || e.status === 403)) throw new BridgeError("auth", AUTH_MESSAGE);
    throw e;
  } finally {
    sub?.close();
  }
}

// ---------- parsing the agent's reply ----------

// The first complete JSON object in `text`, ignoring code fences and surrounding prose.
function extractJson(text: string): any | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

type Parsed =
  | { kind: "final"; text: string }
  | { kind: "tool"; name: string; args: Record<string, any> }
  | { kind: "invalid"; errors: string[] };

const invalid = (...errors: string[]): Parsed => ({ kind: "invalid", errors });

// Turn the agent's reply into a final answer or a validated tool call. Nothing unvalidated is ever returned as a tool call.
function parseReply(text: string, tools: any[]): Parsed {
  const obj = extractJson(text);
  if (!obj || typeof obj !== "object") return invalid("The reply did not contain a complete JSON object.");
  if (obj.type === "final") {
    return typeof obj.text === "string" ? { kind: "final", text: obj.text } : invalid('"final" needs a string field "text".');
  }
  if (obj.type !== "tool_call") return invalid(`"type" must be "tool_call" or "final", got ${JSON.stringify(obj.type)}.`);
  if (typeof obj.name !== "string" || !tools.some((t) => t.name === obj.name)) {
    return invalid(`Unknown tool ${JSON.stringify(obj.name)}. Available tools: ${tools.map((t) => t.name).join(", ")}.`);
  }
  if (!obj.arguments || typeof obj.arguments !== "object" || Array.isArray(obj.arguments)) return invalid('"arguments" must be a JSON object.');
  try {
    const args = validateToolCall(tools, { type: "toolCall", id: "bridge-check", name: obj.name, arguments: obj.arguments });
    return { kind: "tool", name: obj.name, args: args ?? obj.arguments };
  } catch (e: any) {
    return invalid(String(e?.message ?? e).slice(0, 600));
  }
}

// ---------- messages sent to the agent ----------

const PROTOCOL = `[PI BACKEND MODE]
You are acting as the model behind the Pi coding agent. Pi executes all
tools locally; you never execute anything yourself.

Follow Pi's system prompt above wherever it does not conflict with this
protocol. This protocol wins on conflicts.

Rules:
- Do not use your own tools, memory, saved notes, widgets, or web access in
  this thread. Do not save anything to memory from this thread.
- The user's files and computer are reachable ONLY through the Pi tools
  below. Do not start browser tasks, sub-agents, device commands or
  approval requests, and do not search for the files elsewhere.
- Reply with exactly ONE JSON object and nothing else. No prose, no
  markdown, no code fences.
- The object is either:
  {"type":"tool_call","name":"<one of the tools below>","arguments":{...}}
  or:
  {"type":"final","text":"<answer for the user>"}
- One tool call per reply. After Pi runs it, you will receive the result
  and may then request the next step.
- Arguments must validate against the tool's JSON schema. Required fields
  are required. Do not invent tools or fields.
- If the user's request is complete, or no tool is needed, use "final".
- Tool results arrive as {"type":"tool_result","name":...,"ok":...,"content":...}.

Tools available (JSON schema):
`;

const RESYNC_HEAD = "[PI CONTEXT RESYNC] The earlier conversation was compacted. Treat the following as the authoritative current context, replacing anything it contradicts. Respond to its final item according to the protocol.\n";
const CONTEXT_HEAD = "[PI CONTEXT] Current conversation so far; respond to its final item according to the protocol.\n";
const PRIME_ACK = '\n\nReply now with {"type":"final","text":"ready"} only.';

const fingerprint = (m: any) => createHash("sha1").update(JSON.stringify([m?.role, m?.content])).digest("hex").slice(0, 12);

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p: any) => (p?.type === "text" ? p.text : p?.type === "image" ? "[image omitted]" : "")).join("\n");
}

const toolsJson = (tools: any[]) => JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));

function toolResultMessage(m: any): string {
  const build = (c: string) => JSON.stringify(m.isError
    ? { type: "tool_result", name: m.toolName, ok: false, error: c }
    : { type: "tool_result", name: m.toolName, ok: true, content: c });
  return build(fitMiddle(textOf(m.content), Math.min(RESULT_CAP, MSG_CAP - 2_000), build));
}

const assistantText = (m: any): string => (m.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");

// The Pi messages the agent has not seen yet, as plain text (user messages) or tool_result JSON. Replies given in
// chat mode in between are passed on as context.
function deltaText(delta: any[]): string {
  return delta.map((m) => (m.role === "toolResult" ? toolResultMessage(m) : m.role === "user" ? textOf(m.content)
    : m.role === "assistant" && m.model === "muse-chat" && assistantText(m) ? `[Your reply in chat mode] ${assistantText(m)}` : "")).filter(Boolean).join("\n");
}

// The whole current Pi context as text, newest items kept in full and older ones clipped or dropped to fit `budget`.
function serializeContext(messages: any[], budget: number): string {
  const items = messages.map((m, i) => {
    const cap = i === messages.length - 1 ? budget : ITEM_CAP;
    const clip = (s: string) => (s.length > cap ? s.slice(0, Math.ceil(cap * 0.6)) + "\n[... truncated ...]\n" + s.slice(s.length - Math.floor(cap * 0.4)) : s);
    if (m.role === "user") return `[USER] ${clip(textOf(m.content))}`;
    if (m.role === "toolResult") return `[TOOL_RESULT ${m.toolName} ${m.isError ? "error" : "ok"}] ${clip(textOf(m.content))}`;
    if (m.role === "assistant") {
      const parts = (m.content ?? []).map((p: any) => (p.type === "text" ? p.text : p.type === "toolCall" ? JSON.stringify({ type: "tool_call", name: p.name, arguments: p.arguments }) : ""));
      return `[ASSISTANT] ${clip(parts.filter(Boolean).join("\n"))}`;
    }
    return "";
  }).filter(Boolean);
  let omitted = 0;
  while (items.length > 1 && encLen(items.join("\n")) > budget) { items.shift(); omitted++; }
  return (omitted ? `[... ${omitted} earlier items omitted by Muse Bridge ...]\n` : "") + items.join("\n");
}

// ---------- planning a turn ----------

interface TurnInput {
  key: string;
  st: SessionState | undefined;
  messages: any[];
  systemPrompt: string;
  tools: any[];
  toolsText: string;
  toolsFp: string;
  signal?: AbortSignal;
}
interface TurnPlan {
  threadId: string;
  isNew: boolean; // a side chat that does not exist yet (its first message creates it)
  prime?: string; // sent (and acknowledged) first when the priming text cannot share a message with the context
  message: string;
}

// Decide which Muse thread to use and what to send: just the new messages when the thread is in step with Pi,
// otherwise a resync into the same thread (after compaction) or a freshly primed thread.
async function planTurn(t: TurnInput): Promise<TurnPlan> {
  const { st, messages } = t;
  const inStep = !!st && !st.dirty && st.sentCount >= 2 && st.sentCount <= messages.length - 1 &&
    messages[st.sentCount - 1]?.role === "assistant" && fingerprint(messages[st.sentCount - 2]) === st.lastFp;

  if (inStep && st && !st.resync) {
    const delta = messages.slice(st.sentCount);
    if (!delta.length) throw new BridgeError("invalid", "Muse Bridge: Pi asked for a reply but sent no new message.");
    const toolsUpdate = st.toolsFp !== t.toolsFp ? "[PI TOOLS UPDATE] " + t.toolsText + "\n" : "";
    return { threadId: st.threadId, isNew: false, message: REMINDER + "\n" + toolsUpdate + fitMiddle(deltaText(delta), MSG_CAP - encLen(t.toolsText) - 500) };
  }

  if (st && !st.dirty && st.resync) {
    return { threadId: st.threadId, isNew: false, message: REMINDER + "\n" + RESYNC_HEAD + serializeContext(messages, MSG_CAP - 2_000) };
  }

  // New side chat (a fresh id creates it): prime it with Pi's system prompt, the protocol and the tool schemas,
  // plus the current context. Device tokens can't archive chats, so a replaced one is simply left behind.
  const threadId = randomUUID();

  const prime = fitMiddle(t.systemPrompt, Math.max(8_000, MSG_CAP - encLen(t.toolsText) - 4_000)) + "\n\n" + PROTOCOL + t.toolsText;
  const onlyUser = messages.length === 1 && messages[0].role === "user";
  const body = onlyUser ? "User message: " + textOf(messages[0].content) : CONTEXT_HEAD + serializeContext(messages, MSG_CAP - 2_000);
  if (encLen(prime) + encLen(body) + 100 <= MSG_CAP) return { threadId, isNew: true, message: prime + "\n\n" + body };
  return { threadId, isNew: true, prime: prime + PRIME_ACK, message: REMINDER + "\n" + fitMiddle(body, MSG_CAP - 500) };
}

// Chat mode: Muse keeps the conversation in its side chat, so each turn sends only the user's new message(s), as
// they are. sentCount points just past the last user message Muse has; lastFp fingerprints that message. When the
// two no longer line up (Pi compacted, or the history was rewritten) only the newest user message is sent, into the
// same chat. A new chat started mid-session (after using muse/muse-coding) first gets the conversation so far.
function planChat(st: SessionState | undefined, messages: any[]): TurnPlan & { sentCount: number; lastFp: string } {
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
  if (lastUser < 0) throw new BridgeError("invalid", "Muse Bridge: there is no message to send to Muse.");
  const mark = { sentCount: lastUser + 1, lastFp: fingerprint(messages[lastUser]) };
  // New user words, plus any answers given in coding mode in between (as context; tool traffic is left out).
  const userText = (ms: any[]) => ms.map((m) => (m.role === "user" ? textOf(m.content)
    : m.role === "assistant" && m.model !== "muse-chat" && assistantText(m) ? `[Your reply in coding mode] ${assistantText(m)}` : "")).filter(Boolean).join("\n\n");

  if (st) {
    const inStep = st.sentCount >= 1 && st.sentCount <= messages.length && fingerprint(messages[st.sentCount - 1]) === st.lastFp;
    const text = inStep ? userText(messages.slice(st.sentCount)) : textOf(messages[lastUser].content);
    if (!text) throw new BridgeError("invalid", "Muse Bridge: there is no new message to send to Muse.");
    return { threadId: st.threadId, isNew: false, message: fitMiddle(text, MSG_CAP), ...mark };
  }

  const earlier = messages.slice(0, lastUser).filter((m) => m.role === "user" || m.role === "assistant").map((m) => {
    const text = m.role === "user" ? textOf(m.content) : assistantText(m);
    return text ? `[${m.role === "user" ? "Me" : "You"}] ${text.length > ITEM_CAP ? text.slice(0, ITEM_CAP) + " [...]" : text}` : "";
  }).filter(Boolean);
  while (earlier.length && encLen(earlier.join("\n")) > MSG_CAP / 2) earlier.shift();
  const now = textOf(messages[lastUser].content);
  const message = earlier.length ? `[Our conversation so far, from Pi]\n${earlier.join("\n")}\n\n[My new message]\n${now}` : now;
  return { threadId: randomUUID(), isNew: true, message: fitMiddle(message, MSG_CAP), ...mark };
}

function guardWorkingDirectory() {
  const cwd = realPath(process.cwd());
  const denied = DENY_DIRS.find((d) => (d === HOME_REAL ? cwd === d : cwd === d || cwd.startsWith(d + sep)));
  if (denied) throw new BridgeError("denied", `Muse Bridge does not run in ${cwd} (protected: ${denied}). Start Pi in a project folder, or adjust MUSEBRIDGE_DENY_DIRS.`);
}

// ---------- the Pi stream ----------

function streamBridge(model: any, context: any, options?: any) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: any = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "pending", timestamp: Date.now(),
    };
    const mode = modeOf(model);
    const key = modeKey(sessionKey(), mode);
    const signal: AbortSignal | undefined = options?.signal;
    const note = { sent: false };
    try {
      stream.push({ type: "start", partial: output });
      if (mode === "coding") guardWorkingDirectory(); // chat never touches files
      const accessToken: string = options?.apiKey ?? "";
      if (!accessToken || !loadDevice()) throw new BridgeError("auth", "This computer is not paired with Muse yet. Run /login and choose Muse Bridge.");
      if (mode === "chat") return await chatTurn(stream, output, key, context.messages ?? [], accessToken, signal, note);

      const tools: any[] = context.tools ?? [];
      const messages: any[] = context.messages ?? [];
      const systemPrompt: string = context.systemPrompt ?? "";
      const toolsText = toolsJson(tools);
      const toolsFp = createHash("sha1").update(toolsText).digest("hex").slice(0, 12);

      const plan = await planTurn({ key, st: loadState().sessions[key], messages, systemPrompt, tools, toolsText, toolsFp, signal });
      mutateState((all) => {
        all.sessions[key] = { sentCount: 0, lastFp: "", toolsFp: "", ...all.sessions[key], threadId: plan.threadId, dirty: false, resync: false, updated: new Date().toISOString() };
      });
      let fresh = plan.isNew; // only the first message of a new side chat creates it
      const send = (text: string) => { const isNew = fresh; fresh = false; return exchange(plan.threadId, text, isNew, accessToken, signal, note); };
      if (plan.prime) await send(plan.prime);

      // Send; an invalid reply gets exactly one repair message, a second one ends the turn.
      let reply = await send(plan.message);
      let parsed = parseReply(reply, tools);
      if (parsed.kind === "invalid") {
        log("invalid-reply", { errors: parsed.errors, reply });
        const repair = `${REMINDER}\nYour last reply was invalid and was NOT executed:\n- ${parsed.errors.join("\n- ")}\nReply again with exactly one corrected JSON object.`;
        reply = await send(repair);
        parsed = parseReply(reply, tools);
        if (parsed.kind === "invalid") {
          throw new BridgeError("invalid", `The Muse agent twice failed to return a valid protocol reply (${parsed.errors.join("; ")}). Last reply: ${reply.slice(0, 200)}`);
        }
      }

      // Muse reports no usage, so report an estimate (characters / 4): it lets Pi compact at the right time.
      const inputChars = systemPrompt.length + toolsText.length +
        messages.reduce((n, m) => n + (m.role === "assistant" ? JSON.stringify(m.content).length : textOf(m.content).length), 0);
      output.usage.input = Math.ceil(inputChars / 4);
      output.usage.output = Math.ceil(reply.length / 4);
      output.usage.totalTokens = output.usage.input + output.usage.output;

      if (parsed.kind === "final") emitText(stream, output, parsed.text.length ? parsed.text : "(the Muse agent returned an empty answer)");
      else emitToolCall(stream, output, parsed.name, parsed.args);

      updateSession(key, (s) => Object.assign(s, {
        sentCount: messages.length + 1, lastFp: fingerprint(messages[messages.length - 1]), toolsFp, dirty: false, resync: false, updated: new Date().toISOString(),
      }));
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error: any) {
      const aborted = !!signal?.aborted || error?.message === "aborted";
      // The agent may already hold our message: the thread no longer matches Pi's context, so the next turn starts
      // fresh. A chat simply carries on in the same side chat.
      if (note.sent && error?.kind !== "auth" && mode === "coding") { try { updateSession(key, (s) => { s.dirty = true; }); } catch {} }
      output.stopReason = aborted ? "aborted" : "error";
      output.errorMessage = aborted ? "Request aborted" : error instanceof BridgeError ? error.message : `Muse Bridge: ${error?.message ?? error}`;
      log("error", output.errorMessage);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      releaseLink();
    }
  })();
  return stream;
}

// One chat turn: send the user's words, show Muse's reply as it is written, and end when Muse is done.
async function chatTurn(stream: any, output: any, key: string, messages: any[], accessToken: string, signal: AbortSignal | undefined, note: { sent: boolean }) {
  const plan = planChat(loadState().sessions[key], messages);
  mutateState((all) => {
    all.sessions[key] = { toolsFp: "", ...all.sessions[key], threadId: plan.threadId, sentCount: plan.sentCount, lastFp: plan.lastFp, dirty: false, resync: false, updated: new Date().toISOString() };
  });
  let shown = "";
  const show = (text: string) => {
    if (!output.content.length) { output.content.push({ type: "text", text: "" }); stream.push({ type: "text_start", contentIndex: 0, partial: output }); }
    if (!text.startsWith(shown)) return; // Muse rewrote what it had said: the final text replaces it at the end
    const delta = text.slice(shown.length);
    if (!delta) return;
    shown = text;
    output.content[0].text = text;
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
  };
  const reply = (await exchange(plan.threadId, plan.message, plan.isNew, accessToken, signal, note, "chat", show)) || "(Muse sent no reply)";
  show(reply);
  output.content[0].text = reply;
  stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: output });
  output.stopReason = "stop";
  output.usage.input = Math.ceil(messages.reduce((n, m) => n + textOf(m.content).length, 0) / 4);
  output.usage.output = Math.ceil(reply.length / 4);
  output.usage.totalTokens = output.usage.input + output.usage.output;
  stream.push({ type: "done", reason: output.stopReason, message: output });
  stream.end();
}

// The reply arrives whole (there is no token streaming), so it is replayed to Pi in a few chunks.
function emitText(stream: any, output: any, text: string) {
  output.content.push({ type: "text", text: "" });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  for (let i = 0; i < text.length; i += TEXT_CHUNK) {
    const delta = text.slice(i, i + TEXT_CHUNK);
    output.content[0].text += delta;
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
  }
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
  output.stopReason = "stop";
}

function emitToolCall(stream: any, output: any, name: string, args: Record<string, any>) {
  const id = `mb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  output.content.push({ type: "toolCall", id, name, arguments: {} });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
  output.content[0].arguments = args;
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id, name, arguments: args }, partial: output });
  output.stopReason = "toolUse";
}

// ---------- login (Pi's built-in /login) ----------

// Pairing this computer with Muse over Bluetooth yields device tokens, which Pi stores and refreshes like any
// OAuth credential. The extra fields are what refresh needs; identity and endpoints also go to DEVICE_FILE.
const bridgeAuth = {
  oauth: {
    name: "Muse Bridge (pair this computer with your Muse)",
    loginLabel: "Pair this computer with your Muse (Bluetooth)",

    async login(interaction: any) {
      interaction.notify({
        type: "info",
        message: "Muse Bridge pairs this computer with your Muse as a gadget, over Bluetooth, with the Muse app on your phone. First create a Gadget SDK token at gadgets.muse.ai (Account > SDK tokens) and paste it below.",
        links: [{ url: "https://gadgets.muse.ai/settings/sdk-tokens", label: "gadgets.muse.ai SDK tokens" }],
      });
      const sdkToken = (await interaction.prompt({ type: "secret", message: "Gadget SDK token (mgst_...)", placeholder: "mgst_..." })).trim();
      if (!SDK_TOKEN_RE.test(sdkToken)) throw new Error("That does not look like a Gadget SDK token (it starts with mgst_). Copy it again from gadgets.muse.ai and run /login.");

      const identity = loadOrCreateIdentity(join(STATE_DIR, "identity.json"));
      const name = displayName();
      let deviceSaved = false;
      const p = await pairOverBluetooth({
        identity, sdkToken, version: VERSION, binDir: BIN_DIR, signal: interaction.signal,
        notify: (type, message) => interaction.notify({ type, message }),
        afterProvisioned: async (prov) => {
          interaction.notify({ type: "progress", message: "Registering this computer with your Muse..." });
          saveDevice({ mac: identity.mac, apiUrl: prov.apiUrl, noiseHost: prov.noiseHost || DEFAULT_NOISE_HOST, displayName: name });
          deviceSaved = true;
          const vm = prov.vms.find((v) => v.isDefault) ?? prov.vms[0];
          const l = await MuseLink.connect({ noiseHost: prov.noiseHost || DEFAULT_NOISE_HOST, vm, device: { nodeId: identity.nodeId, displayName: name, version: VERSION } });
          l.close(new Error("registered"));
        },
      });
      if (!deviceSaved) throw new Error("Pairing finished without registering the device.");
      interaction.notify({ type: "info", message: `Paired as "${name}". Choose muse/muse-chat (talk to Muse) or muse/muse-coding (Muse drives Pi's tools) with /model.` });
      return {
        type: "oauth" as const,
        access: p.access, refresh: p.refresh, expires: Date.now() + TOKEN_LIFETIME_MS,
        nodeId: identity.nodeId, apiUrl: p.apiUrl || DEFAULT_API, sdkToken,
      };
    },

    async refresh(credential: any, signal: AbortSignal) {
      try {
        const t = await refreshDeviceToken(credential.refresh, credential.nodeId, credential.apiUrl || DEFAULT_API, credential.sdkToken, signal);
        return { ...credential, access: t.access, refresh: t.refresh, expires: Date.now() + TOKEN_LIFETIME_MS };
      } catch (e: any) {
        if (e instanceof MuseHttpError && e.status === 401) throw new Error(AUTH_MESSAGE);
        throw e;
      }
    },

    async toAuth(credential: any) {
      return { apiKey: credential.access };
    },
  },
};

// ---------- extension entry point ----------

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
};

export default function (pi: any) {
  const model = (id: string, name: string) => ({
    id, name, api: "musebridge", provider: "muse", baseUrl: "musebridge://device",
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 225_000, // below Muse's own compaction point, so Pi compacts first
    maxTokens: 8192,
  });
  pi.registerProvider(createProvider({
    id: "muse",
    name: "Muse Bridge",
    baseUrl: "musebridge://device",
    auth: bridgeAuth,
    models: [model("muse-chat", "Muse"), model("muse-coding", "Muse (coding)")],
    api: { stream: streamBridge, streamSimple: streamBridge },
  }));

  pi.on("session_start", async (event: any, ctx: any) => {
    const key = ctx.sessionManager?.getSessionFile?.() ?? `ephemeral:${process.pid}`;
    currentKey = key;
    log("session_start", { reason: event?.reason, key });

    // Forget side chats that will never be resumed: the one a "new" session replaces, and those of file-less
    // (ephemeral) sessions whose Pi process is gone. File-backed sessions are kept, since they can be resumed.
    mutateState((all) => {
      if (event?.reason === "new") { delete all.sessions[key]; delete all.sessions[modeKey(key, "chat")]; }
      for (const k of Object.keys(all.sessions)) {
        if (k.split("#")[0] === key || !k.startsWith("ephemeral:")) continue;
        const pid = Number(k.slice("ephemeral:".length).split("#")[0]);
        if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) continue;
        delete all.sessions[k];
      }
    });
  });

  // After Pi compacts, the next coding turn tells the same Muse side chat what the new context is. (A chat needs
  // nothing: Muse keeps its own history, and the next turn just sends the newest message.)
  pi.on("session_compact", async () => {
    log("session_compact");
    updateSession(sessionKey(), (s) => { s.resync = true; });
  });
}
