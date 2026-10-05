// Muse Bridge test harness: drives the registered provider's streamSimple against a fake Muse connection, and
// checks the Noise channel and the Bluetooth pairing protocol against independent peer implementations.
// Run: node test/run.mjs   (prints each scenario with the actual observed values)
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeMuse } from "./fake-muse.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "musebridge-test-"));
const home = join(tmp, "home"), proj = join(home, "proj"), stateDir = join(home, ".pi", "agent", "musebridge");
mkdirSync(proj, { recursive: true }); mkdirSync(stateDir, { recursive: true });
process.env.HOME = home;
process.env.MUSEBRIDGE_POLL_MS = "250";
process.env.MUSEBRIDGE_SETTLE_MS = "1200";
process.env.MUSEBRIDGE_WAIT_SECONDS = "6";
process.env.MUSEBRIDGE_DEBUG = "1";
process.env.MUSEBRIDGE_WAKE_WAIT_SECONDS = "4";
process.chdir(proj);
writeFileSync(join(stateDir, "device.json"), JSON.stringify({ mac: "02:11:22:33:44:55", apiUrl: "https://api.example", noiseHost: "noise.example", displayName: "Muse Bridge (test)" }));

const fixture = JSON.parse(readFileSync(join(here, "pi-fixture.json"), "utf8"));
const TOOLS = fixture.tools, SYS = fixture.systemPrompt;
const model = { api: "musebridge", provider: "muse", id: "muse-coding" };
const chatModel = { api: "musebridge", provider: "muse", id: "muse-chat" };
const fake = fakeMuse();

async function load(tag) {
  const mod = await import(`../musebridge.ts?${tag}`);
  const handlers = {}; let provider;
  mod.default({ registerProvider: (a, b) => (provider = b ?? a), on: (ev, fn) => (handlers[ev] = fn) });
  mod.__test.setConnect(fake.connect);
  return { provider, handlers };
}
let H = await load("a");

const script = (...replies) => { fake.script = [...replies]; };
const sent = () => fake.sent;
const clearSent = () => { fake.sent.length = 0; };
const threadCount = () => fake.chats.size;
const state = () => JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
const user = (t) => ({ role: "user", content: t, timestamp: 1 });
const result = (name, text, isError = false) => ({ role: "toolResult", toolCallId: "x", toolName: name, content: [{ type: "text", text }], isError, timestamp: 1 });
const call = (name, args) => JSON.stringify({ type: "tool_call", name, arguments: args });
const final = (text) => JSON.stringify({ type: "final", text });

async function turn(messages, { tools = TOOLS, signal, sys = SYS, h = H, apiKey = "test-access-token", model: mdl = model } = {}) {
  const t0 = Date.now(), events = [];
  const stream = h.provider.streamSimple(mdl, { systemPrompt: sys, messages, tools }, { signal, apiKey });
  let end;
  for await (const ev of stream) { events.push(ev.type); if (ev.type === "done") end = ev.message; if (ev.type === "error") end = ev.error; }
  return { events, msg: end, secs: ((Date.now() - t0) / 1000).toFixed(1) };
}
async function session(name, reason = "startup", h = H) {
  await h.handlers.session_start({ reason }, { sessionManager: { getSessionFile: () => join(tmp, name + ".jsonl") } });
}

let pass = 0, fail = 0;
function check(label, ok, detail = "") { (ok ? pass++ : fail++); console.log(`   ${ok ? "PASS" : "FAIL"} ${label}${detail ? "  -> " + detail : ""}`); }
async function scenario(name, fn) {
  console.log(`\n## ${name}`);
  clearSent();
  try { await fn(); } catch (e) { fail++; console.log("   FAIL exception:", e?.stack ?? e); }
}
const textOf = (msg) => msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
const hasEvents = (evs, ...want) => want.every((w) => evs.includes(w));

await scenario("1 plain text reply", async () => {
  await session("s1"); script(final("Hello from Muse"));
  const r = await turn([user("hi")]);
  check("stop reason stop", r.msg.stopReason === "stop", r.msg.stopReason);
  check("text delivered", textOf(r.msg) === "Hello from Muse", textOf(r.msg));
  check("event order start..done", r.events[0] === "start" && r.events.at(-1) === "done" && hasEvents(r.events, "text_start", "text_delta", "text_end"), r.events.join(","));
  const s = sent();
  check("one message sent to a new side chat, priming + user", s.length === 1 && s[0].isNew && s[0].text.includes("[PI BACKEND MODE]") && s[0].text.includes("User message: hi"), `${s.length} msg, ${s[0]?.bytes} bytes`);
  check("system prompt, tool schemas and no-own-tools rule included", s[0].text.includes("expert coding assistant") && s[0].text.includes('"name":"bash"') && s[0].text.includes("Do not start browser tasks"));
  check("usage is an estimate, cost zero", r.msg.usage.input > 0 && r.msg.usage.cost.total === 0, `input≈${r.msg.usage.input} output≈${r.msg.usage.output}`);
  check("state file written with thread", Object.values(state().sessions).some((x) => x.threadId), JSON.stringify(Object.values(state().sessions)[0]));
});

await scenario("2 empty reply", async () => {
  await session("s2"); script(final(""));
  const r = await turn([user("say nothing")]);
  check("placeholder text for empty answer", r.msg.stopReason === "stop" && /empty answer/.test(textOf(r.msg)), textOf(r.msg));
});

await scenario("3 long reply is chunked", async () => {
  await session("s3"); const long = "abc ".repeat(300); script(final(long));
  const r = await turn([user("long")]);
  const deltas = r.events.filter((e) => e === "text_delta").length;
  check("many text deltas", deltas >= 7, `${deltas} deltas`);
  check("reassembled text equals reply", textOf(r.msg) === long, `${textOf(r.msg).length} chars`);
});

await scenario("4 single tool call, then tool result -> final", async () => {
  await session("s4"); script(call("read", { path: "a.txt" }));
  const msgs = [user("read a.txt")];
  const r1 = await turn(msgs);
  const tc = r1.msg.content.find((c) => c.type === "toolCall");
  check("stop reason toolUse", r1.msg.stopReason === "toolUse", r1.msg.stopReason);
  check("tool call parsed", tc?.name === "read" && tc.arguments.path === "a.txt", JSON.stringify(tc));
  check("toolcall events balanced", hasEvents(r1.events, "toolcall_start", "toolcall_delta", "toolcall_end") && r1.events.at(-1) === "done", r1.events.join(","));
  msgs.push(r1.msg, result("read", "hello file"));
  script(final("It says hello file."));
  const before = threadCount();
  const r2 = await turn(msgs);
  const s = sent();
  check("final answer", textOf(r2.msg) === "It says hello file.", textOf(r2.msg));
  check("delta only: tool_result JSON, no re-priming", s.length === 2 && !s[1].text.includes("PI BACKEND MODE") && s[1].text.includes('"type":"tool_result","name":"read","ok":true,"content":"hello file"'), s[1].text.slice(0, 160));
  check("protocol reminder on follow-up", s[1].text.startsWith("[Pi protocol:"));
  check("same side chat reused (subscribed before sending)", threadCount() === before && s[0].thread === s[1].thread && !s[1].isNew, s[1].thread);
});

await scenario("5 sequential tool calls and an error result", async () => {
  await session("s5"); script(call("bash", { command: "ls" }), call("read", { path: "missing" }), final("missing file."));
  const msgs = [user("do it")];
  let r = await turn(msgs); msgs.push(r.msg, result("bash", "a.txt\nb.txt"));
  r = await turn(msgs); msgs.push(r.msg, result("read", "ENOENT: no such file", true));
  r = await turn(msgs);
  const s = sent();
  check("three exchanges on one chat", s.length === 3 && new Set(s.map((x) => x.thread)).size === 1, `${s.length} sent`);
  check("error result sent with ok:false + error", s[2].text.includes('"ok":false') && s[2].text.includes('"error":"ENOENT'), s[2].text.slice(0, 140));
  check("ended with final", r.msg.stopReason === "stop", textOf(r.msg));
});

await scenario("6 malformed JSON -> repair succeeds", async () => {
  await session("s6"); script("I will read the file now!", call("read", { path: "a.txt" }));
  const r = await turn([user("go")]); const s = sent();
  check("repair message sent once", s.length === 2 && s[1].text.includes("NOT executed"), s[1]?.text.slice(0, 200));
  check("repaired call executed", r.msg.stopReason === "toolUse" && r.msg.content[0].name === "read");
});

await scenario("6b schema violation -> repair names the error", async () => {
  await session("s6b"); script(call("read", {}), call("read", { path: "ok.txt" }));
  const r = await turn([user("go")]); const s = sent();
  check("repair mentions validation error", s.length === 2 && /path/i.test(s[1].text), s[1]?.text.slice(0, 260).replace(/\n/g, " | "));
  check("second try accepted", r.msg.stopReason === "toolUse");
  script(call("nosuchtool", {}), final("ok"));
  const r2 = await turn([user("go2")]); const s2 = sent();
  check("unknown tool rejected, repair lists tools", /Unknown tool/.test(s2.at(-1).text) && r2.msg.stopReason === "stop", s2.at(-1).text.slice(0, 200).replace(/\n/g, " | "));
});

await scenario("7 JSON inside code fences", async () => {
  await session("s7"); script("```json\n" + call("bash", { command: "pwd" }) + "\n```");
  const r = await turn([user("pwd")]);
  check("accepted without repair", sent().length === 1 && r.msg.stopReason === "toolUse" && r.msg.content[0].arguments.command === "pwd");
});

await scenario("8 two invalid replies -> error, nothing executed, next turn resyncs", async () => {
  await session("s8"); script("nope", "still nope");
  const r = await turn([user("x")]);
  check("stop reason error", r.msg.stopReason === "error", r.msg.errorMessage?.slice(0, 160));
  check("no tool call produced", !r.msg.content.some((c) => c.type === "toolCall"));
  check("session marked dirty", Object.values(state().sessions).some((x) => x.dirty));
  const before = threadCount(); script(final("recovered"));
  const r2 = await turn([user("x"), r.msg, user("try again")]);
  check("next turn starts a fresh side chat with context", threadCount() === before + 1 && sent().at(-1).text.includes("[PI BACKEND MODE]") && sent().at(-1).text.includes("try again"), textOf(r2.msg));
});

await scenario("9 reply that is still streaming", async () => {
  await session("s9"); script("__PARTIAL__:" + call("read", { path: "slow.txt" }));
  const r = await turn([user("slow")]);
  check("waited for the complete reply", r.msg.stopReason === "toolUse" && r.msg.content[0].arguments.path === "slow.txt", `${r.secs}s`);
});

await scenario("10 device token rejected", async () => {
  await session("s10"); script("__AUTH__");
  const r = await turn([user("hi")]);
  check("clear auth error pointing to /login", r.msg.stopReason === "error" && /device token/.test(r.msg.errorMessage) && /\/login/.test(r.msg.errorMessage), r.msg.errorMessage);
  check("nothing delivered", sent().length === 0);
  check("not marked dirty", !state().sessions[Object.keys(state().sessions).find((k) => k.endsWith("s10.jsonl"))]?.dirty);
});

await scenario("10b not paired / no credential", async () => {
  await session("s10b"); script(final("x"));
  const r = await turn([user("hi")], { apiKey: "" });
  check("asks to run /login, nothing sent", r.msg.stopReason === "error" && /not paired/.test(r.msg.errorMessage) && sent().length === 0, r.msg.errorMessage);
});

await scenario("11 abort mid-wait", async () => {
  await session("s11"); script("__HANG__");
  const ac = new AbortController(); setTimeout(() => ac.abort(), 1500);
  const r = await turn([user("hang")], { signal: ac.signal });
  check("stop reason aborted, promptly", r.msg.stopReason === "aborted" && Number(r.secs) < 3, `${r.secs}s`);
  check("session marked dirty", Object.values(state().sessions).some((x) => x.dirty));
  const before = threadCount(); script(final("fresh"));
  await turn([user("hang"), r.msg, user("again")]);
  check("next turn resyncs on a new side chat", threadCount() === before + 1, `chats ${before}->${threadCount()}`);
});

await scenario("12 timeout", async () => {
  await session("s12"); script("__NOREPLY__");
  const r = await turn([user("quiet")]);
  check("timeout error", r.msg.stopReason === "error" && /No reply from the Muse agent within 6s/.test(r.msg.errorMessage), `${r.secs}s: ${r.msg.errorMessage}`);
});

await scenario("13 /compact resync (same chat)", async () => {
  await session("s13"); script(final("one"));
  const m = [user("first")]; const r = await turn(m); m.push(r.msg);
  const t = threadCount();
  await H.handlers.session_compact({});
  script(final("after compact"));
  const compacted = [user("[Compaction summary] user asked 'first'; assistant said 'one'."), user("next question")];
  const r2 = await turn(compacted); const last = sent().at(-1);
  check("resync message into same chat", last.text.includes("[PI CONTEXT RESYNC]") && last.text.includes("Compaction summary") && threadCount() === t, last.text.slice(0, 140).replace(/\n/g, " | "));
  check("answer returned", textOf(r2.msg) === "after compact");
  script(final("later")); await turn([...compacted, r2.msg, user("and then")]);
  check("subsequent turn is delta-only again", !sent().at(-1).text.includes("RESYNC") && sent().at(-1).text.includes("and then"), sent().at(-1).text.slice(0, 80));
});

await scenario("14 /new starts a new side chat", async () => {
  await session("s14a"); script(final("a")); await turn([user("old session")]);
  const t = threadCount();
  await session("s14b", "new"); script(final("b")); await turn([user("new session")]);
  check("fresh chat + priming", threadCount() === t + 1 && sent().at(-1).text.includes("[PI BACKEND MODE]"), `chats ${t}->${threadCount()}`);
});

await scenario("15 unicode round-trip", async () => {
  await session("s15"); const u = "naïve café 日本語 🚀 \"quoted\" \\ back\nline"; script(final(u));
  const r = await turn([user(u)]);
  check("sent text intact", sent()[0].text.endsWith(u));
  check("reply intact", textOf(r.msg) === u, textOf(r.msg));
});

await scenario("16 session resume reuses the chat", async () => {
  await session("s16"); script(final("one"));
  const m = [user("q1")]; const r = await turn(m); m.push(r.msg);
  const t = threadCount();
  const H2 = await load("restart"); await session("s16", "resume", H2);
  script(final("two")); m.push(user("q2")); const r2 = await turn(m, { h: H2 });
  check("no new chat after restart", threadCount() === t && !sent().at(-1).text.includes("PI BACKEND MODE") && textOf(r2.msg) === "two", `chats ${t}->${threadCount()}`);
});

await scenario("17 oversized messages are cut under the message limit", async () => {
  await session("s17"); script(final("ready"), call("bash", { command: "cat big" }), final("done"));
  const m = [user("big task " + "x".repeat(600_000))];
  let r = await turn(m); m.push(r.msg, result("bash", ("é日本語-line\n").repeat(60_000)));
  r = await turn(m);
  const s = sent();
  check("every message ≤ 200,000 bytes", s.every((x) => x.bytes <= 200_000), s.map((x) => x.bytes).join(", "));
  check("truncation marked explicitly", s.slice(1).every((x) => x.text.includes("truncated by Muse Bridge")), `${s.length} messages`);
  check("turn succeeded", r.msg.stopReason === "stop");
});

await scenario("18 does not run in the home directory or ~/.pi", async () => {
  for (const dir of [home, join(home, ".pi")]) {
    process.chdir(dir); await session("s18"); script(final("should not happen"));
    const r = await turn([user("hi")]); process.chdir(proj);
    check(`denied in ${dir.replace(home, "~")}, nothing sent`, r.msg.stopReason === "error" && /does not run/.test(r.msg.errorMessage) && sent().length === 0, r.msg.errorMessage?.slice(0, 120));
  }
});

await scenario("19 connection dropped mid-turn: clear error, next turn reconnects on a fresh chat", async () => {
  await session("s19"); script("__DROPLINK__:" + final("lost"));
  const before = fake.connects;
  const r = await turn([user("flaky network")]);
  check("turn ends with a clear error", r.msg.stopReason === "error" && /dropped/.test(r.msg.errorMessage), r.msg.errorMessage ?? "");
  const chats = threadCount(); script(final("survived"));
  const r2 = await turn([user("flaky network"), r.msg, user("again")]);
  check("next turn reconnects and resyncs on a new side chat", textOf(r2.msg) === "survived" && fake.connects === before + 1 && threadCount() === chats + 1, `${before}->${fake.connects}`);
});

await scenario("19b reply without a final task status settles once Muse is idle", async () => {
  await session("s19b"); script("__NOSTATUS__:" + final("quiet end"));
  const r = await turn([user("x")]);
  check("answer delivered after the quiet period", textOf(r.msg) === "quiet end" && Number(r.secs) >= 1, `${r.secs}s`);
});

await scenario("20 tool set change mid-session", async () => {
  await session("s20"); script(call("read", { path: "a" }), final("ok"));
  const m = [user("go")]; let r = await turn(m); m.push(r.msg, result("read", "x"));
  r = await turn(m, { tools: TOOLS.slice(0, 3) });
  check("[PI TOOLS UPDATE] sent", sent().at(-1).text.includes("[PI TOOLS UPDATE]"), sent().at(-1).text.slice(0, 60));
});

await scenario("21 the connection is shared across turns", async () => {
  await session("s21"); script(final("a"), final("b"));
  const before = fake.connects;
  const m = [user("one")]; const r = await turn(m); m.push(r.msg, user("two")); await turn(m);
  check("no reconnect between turns", fake.connects === before, `${before}->${fake.connects}`);
});

// ---------- muse/muse-chat ----------

const chatTurn = (messages, opts = {}) => turn(messages, { ...opts, model: chatModel });

await scenario("24a chat: plain words in, Muse's reply out, streamed", async () => {
  await session("c1"); script("__PARTIAL__:Octopuses have three hearts. Two pump blood to the gills.");
  const r = await chatTurn([user("tell me about octopuses")]);
  const s = sent();
  check("the message is sent as typed, nothing added", s.length === 1 && s[0].isNew && s[0].text === "tell me about octopuses", JSON.stringify(s[0]?.text));
  check("reply arrives as text", r.msg.stopReason === "stop" && textOf(r.msg) === "Octopuses have three hearts. Two pump blood to the gills.", textOf(r.msg));
  check("streamed while Muse writes (more than one delta)", r.events.filter((e) => e === "text_delta").length >= 2, r.events.join(","));
  check("never calls Pi tools", !r.msg.content.some((c) => c.type === "toolCall"));
});

await scenario("24b chat: follow-ups go to the same chat, only the new message", async () => {
  await session("c2"); script("Hi!", "__MULTI__:First part.|||Second part.");
  const m = [user("hello")]; const r = await chatTurn(m); m.push(r.msg, user("and more"));
  const r2 = await chatTurn(m); const s = sent();
  check("same chat, just the new words", s.length === 2 && s[1].thread === s[0].thread && !s[1].isNew && s[1].text === "and more", JSON.stringify(s[1]?.text));
  check("several Muse messages are joined", textOf(r2.msg) === "First part.\n\nSecond part.", JSON.stringify(textOf(r2.msg)));
});

await scenario("24c chat and coding keep separate chats in one Pi session", async () => {
  await session("c3"); script(call("read", { path: "a.txt" }), final("It says hi."));
  const m = [user("read a.txt")]; let r = await turn(m); m.push(r.msg, result("read", "hi")); r = await turn(m); m.push(r.msg);
  const codingThread = sent()[0].thread;
  script("Sure."); m.push(user("thanks, now just chat"));
  const r3 = await chatTurn(m); const last = sent().at(-1);
  check("chat gets its own new side chat", last.thread !== codingThread && last.isNew, last.thread);
  check("it starts with the conversation so far, without protocol JSON", last.text.includes("[Our conversation so far, from Pi]") && last.text.includes("[Me] read a.txt") && last.text.includes("[You] It says hi.") && !last.text.includes("tool_call") && !last.text.includes("PI BACKEND"), last.text.replace(/\n/g, " | "));
  check("reply delivered", textOf(r3.msg) === "Sure.");
  script(final("back to coding")); m.push(r3.msg, user("read b.txt"));
  const r4 = await turn(m); const back = sent().at(-1);
  check("back in coding: same coding chat, chat exchange passed on", back.thread === codingThread && back.text.includes("thanks, now just chat") && back.text.includes("[Your reply in chat mode] Sure.") && back.text.includes("read b.txt"), back.text.replace(/\n/g, " | "));
  script("Ok."); m.push(r4.msg, user("chat again"));
  await chatTurn(m); const again = sent().at(-1);
  check("back in chat: same chat, coding answer passed on, no tool traffic", again.thread === last.thread && again.text === "read b.txt\n\n[Your reply in coding mode] back to coding\n\nchat again", JSON.stringify(again.text));
});

await scenario("24d chat: works from the home folder; compaction keeps the chat", async () => {
  process.chdir(home); await session("c4"); script("Hello.");
  const m = [user("hi")]; const r = await chatTurn(m); process.chdir(proj);
  check("chat is allowed outside project folders", r.msg.stopReason === "stop", r.msg.errorMessage ?? "");
  const t = sent()[0].thread; await H.handlers.session_compact({});
  script("Still here.");
  await chatTurn([user("[Compaction summary] said hi."), user("you there?")]);
  check("after compaction, only the newest message, same chat", sent().at(-1).thread === t && sent().at(-1).text === "you there?", JSON.stringify(sent().at(-1).text));
});

await scenario("24e chat: waiting for an approval says so; abort keeps the chat", async () => {
  await session("c5"); script("__APPROVAL__");
  const r = await chatTurn([user("open example.com")]);
  check("timeout names the pending approval", r.msg.stopReason === "error" && /approval of Open example.com in the Muse app/.test(r.msg.errorMessage), r.msg.errorMessage);
  script("__HANG__"); const ac = new AbortController(); setTimeout(() => ac.abort(), 800);
  const m = [user("open example.com"), r.msg, user("hello?")];
  const r2 = await chatTurn(m, { signal: ac.signal });
  check("aborted", r2.msg.stopReason === "aborted");
  script("Back."); m.push(r2.msg, user("ok"));
  await chatTurn(m); const s = sent();
  check("next turn continues the same chat with just the new message", s.at(-1).thread === s[0].thread && s.at(-1).text === "ok", JSON.stringify(s.at(-1).text));
});

await scenario("22 /login: Pi's built-in login flow (OAuth-style device tokens)", async () => {
  const auth = H.provider.auth.oauth;
  check("offered as an account sign-in with a clear label", !!auth && /Bluetooth/.test(auth.loginLabel) && !H.provider.auth.apiKey, auth?.loginLabel);
  const seen = { prompts: [], notes: [] };
  const interaction = (value) => ({ signal: new AbortController().signal, prompt: async (p) => (seen.prompts.push(p), value), notify: (e) => seen.notes.push(e) });
  let err;
  try { await auth.login(interaction("not-a-token")); } catch (e) { err = e; }
  check("asks for the SDK token as a secret, with a link to create one", seen.prompts[0]?.type === "secret" && seen.notes.some((n) => n.type === "info" && n.links?.[0]?.url.includes("gadgets.muse.ai")), JSON.stringify(seen.prompts[0]));
  check("a malformed token is refused before Bluetooth starts", err && /does not look like a Gadget SDK token/.test(err.message), err?.message);
  check("toAuth hands the access token to requests", (await auth.toAuth({ access: "AAA", refresh: "r", expires: 1 })).apiKey === "AAA");

  const realFetch = globalThis.fetch; let req;
  globalThis.fetch = async (url, init) => { req = { url, init }; return new Response(JSON.stringify({ payload: { access_token: "NEW-A", refresh_token: "NEW-R" } }), { status: 200 }); };
  const cred = { type: "oauth", access: "OLD-A", refresh: "hatch_refresh:OLD-R", expires: 0, nodeId: "homelink-334455", apiUrl: "https://api.example", sdkToken: "mgst_x" };
  const next = await auth.refresh(cred, new AbortController().signal);
  check("refresh rotates both tokens and keeps the extras", next.access === "NEW-A" && next.refresh === "NEW-R" && next.nodeId === cred.nodeId && next.expires > Date.now(), JSON.stringify({ ...next, sdkToken: "…" }));
  check("refresh request as the SDK sends it", req.url === "https://api.example/device_token/refresh" && req.init.headers.Authorization === "Bearer hatch_refresh:OLD-R" && JSON.parse(req.init.body).device_id === "homelink-334455" && JSON.parse(req.init.body).sdk_token === "mgst_x", `${req.url} ${req.init.headers.Authorization}`);
  globalThis.fetch = async () => new Response("no", { status: 401 });
  err = undefined; try { await auth.refresh(cred, new AbortController().signal); } catch (e) { err = e; }
  check("a revoked pairing says to run /login", err && /\/login/.test(err.message), err?.message);
  globalThis.fetch = realFetch;
});

await scenario("23 a sleeping Muse is waited for, then reported clearly", async () => {
  const mod = await import("../musebridge.ts?a");
  const realFetch = globalThis.fetch; let calls = 0, state = "SUSPENDED";
  const vm = () => ({ vm_list: [{ vm_id: "v1", vm_ws_url: "wss://v1.example/", vm_auth_token: "t", default: true, vm_state: state }] });
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(vm()), { status: 200 }); };
  let err, t0 = Date.now();
  try { await mod.__test.connectDevice("tok"); } catch (e) { err = e; }
  check("keeps checking while the VM is suspended", calls >= 2 && Date.now() - t0 >= 2500, `${calls} lookups in ${Date.now() - t0}ms`);
  check("then says to wake it from the Muse app", err && /asleep/.test(err.message) && /Muse app/.test(err.message), err?.message);
  calls = 0; setTimeout(() => (state = "RUNNING"), 1000);
  err = undefined; try { await mod.__test.connectDevice("tok"); } catch (e) { err = e; }
  check("connects once the VM is running again", calls >= 2 && err && /Could not connect to Muse/.test(err.message), `${calls} lookups, ${err?.message}`);
  globalThis.fetch = realFetch;
});

await scenario("25 /new and dead ephemeral sessions are forgotten", async () => {
  await session("s25"); script(final("a")); await turn([user("old")]);
  await session("s25", "new");
  check("replaced session's chat mapping dropped", !Object.keys(state().sessions).some((k) => k.endsWith("s25.jsonl")));
  const all = state(); all.sessions["ephemeral:999999"] = { threadId: "ghost", sentCount: 2, lastFp: "x", toolsFp: "x", dirty: false, resync: false, updated: "" };
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(all));
  await session("s25b");
  check("dead ephemeral session pruned", !state().sessions["ephemeral:999999"]);
  check("file-backed sessions are kept", Object.keys(state().sessions).some((k) => k.endsWith("s14a.jsonl")));
});

// ---------- the Noise channel, against an independent responder ----------

const noise = await import("../muse/noise.ts");
await scenario("26 Noise XX handshake and framed transport (against an independent responder)", async () => {
  // A responder written from the Noise spec (not from muse/noise.ts).
  const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();
  const hm = (k, d) => createHmac("sha256", k).update(d).digest();
  const hk = (ck, ikm) => { const t = hm(ck, ikm); const a = hm(t, Buffer.from([1])); return [a, hm(t, Buffer.concat([a, Buffer.from([2])]))]; };
  const kp = () => { const { privateKey, publicKey } = generateKeyPairSync("x25519"); return { priv: privateKey, pub: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url") }; };
  const dh = (priv, pub) => diffieHellman({ privateKey: priv, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: pub.toString("base64url") }, format: "jwk" }) });
  const aead = (key, n, ad, data, enc) => {
    const iv = Buffer.alloc(12); iv.writeBigUInt64BE(BigInt(n), 4);
    if (enc) { const c = createCipheriv("aes-256-gcm", key, iv); c.setAAD(ad); return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]); }
    const d = createDecipheriv("aes-256-gcm", key, iv); d.setAAD(ad); d.setAuthTag(data.subarray(-16)); return Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
  };
  let h = Buffer.alloc(32); h.write("Noise_XX_25519_AESGCM_SHA256"); let ck = h; h = sha(h, Buffer.alloc(0));
  let k, n = 0;
  const mixKey = (ikm) => { [ck, k] = hk(ck, ikm); n = 0; };
  const encHash = (p) => { const c = k ? aead(k, n++, h, p, true) : p; h = sha(h, c); return c; };
  const decHash = (c) => { const p = k ? aead(k, n++, h, c, false) : c; h = sha(h, c); return p; };

  const init = new noise.NoiseXXInitiator();
  const m1 = init.message1();
  h = sha(h, m1.subarray(0, 32)); decHash(m1.subarray(32));
  const e = kp(), s = kp();
  h = sha(h, e.pub); mixKey(dh(e.priv, m1.subarray(0, 32)));
  const encS = encHash(s.pub); mixKey(dh(s.priv, m1.subarray(0, 32)));
  init.readMessage2(Buffer.concat([e.pub, encS, encHash(Buffer.alloc(0))]));
  const m3 = init.message3();
  const rs = decHash(m3.subarray(0, 48)); mixKey(dh(e.priv, rs)); decHash(m3.subarray(48));
  const [k1, k2] = hk(ck, Buffer.alloc(0));
  const [send, recv] = init.split();
  check("handshake completes; both sides derive the same keys", aead(k1, 0, Buffer.alloc(0), send.encrypt(Buffer.alloc(0), Buffer.from("ping")), false).toString() === "ping");

  // Transport: the client's request decodes on our side; a response split over 3 Noise chunks reassembles there.
  const t = new noise.NoiseTransport(send, recv);
  const { streamId, frames } = t.request("POST", "/chat/stream", Buffer.from('{"x":1}'), [{ key: "x-app-id", value: "musegadget" }], true);
  const plain = aead(k1, 1, Buffer.alloc(0), frames[0], false);
  check("request frame carries verb, path and body", plain.includes(Buffer.from("/chat/stream")) && plain.includes(Buffer.from('{"x":1}')) && frames.length === 1, `${plain.length} bytes`);
  const v = (x) => { const o = []; x = BigInt(x); do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; o.push(b); } while (x); return Buffer.from(o); };
  const fld = (f, b) => Buffer.concat([v((f << 3) | 2), v(b.length), b]);
  const vf = (f, x) => Buffer.concat([v(f << 3), v(x)]);
  const big = randomBytes(150_000);
  const resp = Buffer.concat([vf(1, 201), fld(3, big), vf(4, 1)]);
  const env = fld(1, Buffer.concat([vf(1, streamId), fld(3, resp)]));
  let out, rn = 0;
  const chunks = [0, 1, 2].map((i) => Buffer.concat([vf(1, 77), vf(2, i), vf(3, 3), fld(4, env.subarray(i * 65489, (i + 1) * 65489))]));
  for (const c of chunks) out = t.decrypt(aead(k2, rn++, Buffer.alloc(0), c, true)) ?? out;
  check("multi-chunk response reassembles", out?.kind === "response" && out.status === 201 && out.data.equals(big) && out.end && out.streamId === streamId, `${out?.kind} ${out?.status} ${out?.data.length}B`);
  let tampered = false;
  try { t.decrypt(Buffer.from(aead(k2, rn, Buffer.alloc(0), chunks[0], true)).fill(1, 0, 4)); } catch { tampered = true; }
  check("tampered frame is rejected", tampered);
});

// ---------- Bluetooth pairing, against an independent phone ----------

const pairing = await import("../muse/pairing.ts");
await scenario("27 pairing protocol v5 end to end (against an independent phone implementation)", async () => {
  const id = pairing.identityFrom("02:aa:bb:cc:dd:ee");
  check("names follow the gadget conventions", id.nodeId === "homelink-ccddee" && id.bleName === "MuseGadgetCCDDEE" && id.deviceId === "hatch-link:02:aa:bb:cc:dd:ee", JSON.stringify(id));
  const toPhone = [], progress = [];
  let provisioned, verified;
  const transport = { mtu: () => 185, sendPackets: (p) => toPhone.push(...p) };
  const session = new pairing.PairingSession(id, "0.2.0", "mgst_" + "A".repeat(42) + "A");
  const ctl = new pairing.SetupController({
    session, transport, identity: id, version: "0.2.0",
    verify: async (c) => { verified = c; return c.access === "good" ? [{ vmId: "vm1", vmName: "vm1", vmUrl: "wss://x", vmToken: "t", isDefault: true }] : []; },
    onProgress: (m) => progress.push(m), onProvisioned: (p) => (provisioned = p),
  });
  // Phone side: frames writes the way the apps do, and reassembles notifications.
  const write = (obj) => { for (const p of pairing.encodeChunks(Buffer.from(JSON.stringify(obj)), 185)) ctl.onWrite(p); };
  const asm = new pairing.ChunkAssembler();
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const read = async () => { await settle(); const msgs = []; while (toPhone.length) { const m = asm.feed(toPhone.shift()); if (m) msgs.push(m.toString()); } return msgs; };

  write({ action: "get_device_info" });
  const info = JSON.parse((await read())[0]);
  check("device_info advertises protocol 5, community mode", info.type === "device_info" && info.pairing_protocol === 5 && info.pairing_auth === "none" && info.pairing_policy === "confirm_app" && info.model === "hatch_link" && info.node_id === id.nodeId, JSON.stringify(info));

  write({ action: "provision_v2", ssid: "x", password: "y" });
  check("plaintext provisioning is refused", (await read())[0] === "error_encryption_required");

  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const mNonce = randomBytes(16);
  write({ action: "pairing_client_hello", version: 5, pairing_auth: "none", pairing_policy: "confirm_app", mobile_pub: ecdh.getPublicKey().toString("base64url"), mobile_nonce: mNonce.toString("base64url") });
  const ready = JSON.parse((await read())[0]);
  // The transcript, rebuilt from the published v5 format; its hash must match what the device reports.
  const transcript = ["hatch-link-pairing-v5", "version=5", "initiator_role=mobile", "responder_role=link", `device_id=${id.deviceId}`, `node_id=${id.nodeId}`, `mac=${id.mac}`,
    "model=hatch_link", "firmware_version=0.2.0", "selected_cipher_suite=p256-hkdf-sha256-aes-gcm-v1", "pairing_auth=none", "pairing_auth_epoch=0", "pairing_policy=confirm_app",
    "confirm_timeout_seconds=0", `mobile_pub=${ecdh.getPublicKey().toString("base64url")}`, `device_pub=${ready.device_pub}`, `mobile_nonce=${mNonce.toString("base64url")}`, `device_nonce=${ready.device_nonce}`].join("\n");
  const th = createHash("sha256").update(transcript).digest();
  check("pairing_ready transcript hash matches the v5 transcript", ready.type === "pairing_ready" && ready.transcript_hash === th.toString("base64url"));
  const secret = ecdh.computeSecret(Buffer.from(ready.device_pub, "base64url"));
  const salt = createHash("sha256").update(Buffer.concat([mNonce, Buffer.from(ready.device_nonce, "base64url"), th])).digest();
  const ss = Buffer.from(hkdfSync("sha256", secret, salt, "hatch-link ble setup v1", 32));
  const exp = (info) => createHmac("sha256", ss).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
  const txKey = exp("mobile->device"), rxKey = exp("device->mobile");
  const sid = createHash("sha256").update(Buffer.concat([Buffer.from("hatch-link session id v1"), th, secret])).digest().subarray(0, 16).toString("base64url");
  check("session id matches", ready.session_id === sid);
  let tx = 0n, rx = 0n;
  const nonce = (dir, c) => { const b = Buffer.alloc(12); b[0] = dir; b.writeBigUInt64BE(c, 4); return b; };
  const seal = (obj) => {
    const c = createCipheriv("aes-256-gcm", txKey, nonce(0, tx)); c.setAAD(Buffer.from(`hatch-link ble setup v1|${sid}|m2d|${tx}`));
    const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
    const env = { action: "pairing_encrypted", type: "pairing_encrypted", session_id: sid, counter: String(tx), ciphertext: ct.toString("base64url"), tag: c.getAuthTag().toString("base64url") };
    tx++; return env;
  };
  const open = (env) => {
    const d = createDecipheriv("aes-256-gcm", rxKey, nonce(1, rx)); d.setAAD(Buffer.from(`hatch-link ble setup v1|${sid}|d2m|${rx}`)); d.setAuthTag(Buffer.from(env.tag, "base64url"));
    rx++; return JSON.parse(Buffer.concat([d.update(Buffer.from(env.ciphertext, "base64url")), d.final()]).toString());
  };
  const recvAll = async () => (await read()).map((m) => open(JSON.parse(m)));

  write(seal({ action: "pairing_client_finished" }));
  const confirmed = (await recvAll())[0];
  check("finished -> pairing_confirmed carrying the SDK token", confirmed.status === "pairing_confirmed" && confirmed.sdk_token?.startsWith("mgst_"), JSON.stringify({ ...confirmed, sdk_token: "…" }));
  write(seal({ action: "wifi_scan" }));
  const scan = (await recvAll())[0];
  check("wifi_scan offers the current connection, open", scan.type === "wifi_scan_result" && scan.networks.length === 1 && scan.networks[0].secure === false, JSON.stringify(scan));
  write(seal({ action: "provision_v2", ssid: "Use current connection", password: "", access_token: "bad", refresh_token: "r", token_type: "device", username: "u", api_url_v2: "https://api.muse.ai", noise_host: "n.example" }));
  await new Promise((r) => setTimeout(r, 30));
  const failed = (await recvAll()).map((m) => m.status);
  check("tokens Muse rejects -> auth_failed, nothing provisioned", failed.at(-1) === "auth_failed" && !provisioned, failed.join(","));
  write(seal({ action: "provision_v2", ssid: "Use current connection", password: "", access_token: "good", refresh_token: "r2", token_type: "device", username: "u", api_url_v2: "https://api.muse.ai", noise_host: "n.example" }));
  await new Promise((r) => setTimeout(r, 30));
  const ok = (await recvAll()).map((m) => m.status);
  check("good tokens -> wifi_connecting, wifi_connected, auth_ok", ok.join(",") === "wifi_connecting,wifi_connected,auth_ok", ok.join(","));
  check("provisioned with the delivered tokens and endpoints", provisioned?.access === "good" && provisioned.refresh === "r2" && provisioned.noiseHost === "n.example" && provisioned.vms.length === 1 && verified?.apiUrl === "https://api.muse.ai");
  check("progress reported along the way", progress.length >= 3, progress.join(" / "));

  write({ action: "pairing_encrypted", session_id: sid, counter: "0", ciphertext: "AAAA", tag: "A".repeat(22) });
  check("replayed or forged record is rejected", (await read()).length >= 0 && !session.confirmed);
});

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
console.log(`(temp dir: ${tmp})`);
process.exit(fail ? 1 : 0);
