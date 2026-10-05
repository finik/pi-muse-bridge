// A fake Muse for the test harness: stands in for a connected MuseLink. Replies come from a script; every message
// sent is recorded. It follows the real service: a side chat exists once its first message is sent, subscribing to
// a missing chat is a 404, subscribing replays the chat's latest task status, and a reply arrives on the chat's
// event stream as message_start, text_append deltas and message_done, between task.status running and completed.
//
// Script entries: plain reply text, or
//   __AUTH__              the send is rejected (401)
//   __HANG__ / __NOREPLY__ Muse starts working and never answers
//   __APPROVAL__          Muse starts working and waits for an approval in the app
//   __PARTIAL__:<text>    the first half arrives, the rest 2.5 s later
//   __MULTI__:<a>|||<b>   two separate assistant messages
//   __NOSTATUS__:<text>   the reply arrives but the final task status never does
//   __DROPLINK__:<text>   the connection drops just after the send
import { MuseHttpError } from "../muse/link.ts";

export function fakeMuse() {
  const m = { script: [], sent: [], chats: new Map(), connects: 0, links: [], delayMs: 150 };
  let seq = 0;
  const ev = (name, payload) => ({ type: "event", event: name, payload });

  m.connect = async () => {
    m.connects++;
    const subs = new Map(); // sessionId -> Set(onEvent)
    const emit = (sid, name, payload) => { if (!link.closed) for (const fn of subs.get(sid) ?? []) fn(ev(name, { session_id: sid, ...payload })); };
    const at = (ms, fn) => setTimeout(fn, ms);
    const link = {
      closed: false, onClose: undefined,
      close(why) { if (!link.closed) { link.closed = true; link.onClose?.(why ?? new Error("closed")); } },
      async sendChat(text, sid) {
        if (link.closed) throw new Error("Muse connection is closed");
        const step = m.script.shift() ?? "__NOREPLY__";
        if (step === "__AUTH__") throw new MuseHttpError(401, "Muse /chat/stream");
        const isNew = !m.chats.has(sid);
        const chat = m.chats.get(sid) ?? { status: "completed" };
        m.chats.set(sid, chat);
        const messageId = `u${++seq}`;
        m.sent.push({ text, thread: sid, isNew, bytes: Buffer.byteLength(JSON.stringify(text)) });
        const d = m.delayMs;
        const running = () => { chat.status = "running"; emit(sid, "task.status", { status: "running", task_id: "task-1" }); emit(sid, "agent.status", { activity_code: "working", activity_text: "is working" }); };
        const completed = () => { chat.status = "completed"; emit(sid, "agent.status", { activity_code: "online" }); emit(sid, "task.status", { status: "completed", task_id: "task-1" }); };
        const message = (t, start, { split = false, gap = 0 } = {}) => {
          const id = `a${++seq}`, half = split ? Math.floor(t.length / 2) : t.length;
          at(start, () => { emit(sid, "delta.message_start", { message_id: id }); emit(sid, "delta.text_append", { message_id: id, text: t.slice(0, half) }); });
          at(start + gap, () => { if (half < t.length) emit(sid, "delta.text_append", { message_id: id, text: t.slice(half) }); emit(sid, "delta.message_done", { message_id: id, display_text: t }); });
        };
        at(d / 2, running);
        if (step === "__HANG__" || step === "__NOREPLY__") return { messageId, sessionId: sid };
        if (step === "__APPROVAL__") {
          at(d, () => emit(sid, "approvals.snapshot", { pending_approvals: [{ approval_id: "x", display: { title: "Open example.com" } }] }));
          return { messageId, sessionId: sid };
        }
        let reply = step;
        if (step.startsWith("__PARTIAL__:")) { message(step.slice(12), d, { split: true, gap: 2500 }); at(d + 2600, completed); }
        else if (step.startsWith("__MULTI__:")) { const [a, b] = step.slice(10).split("|||"); message(a, d); message(b, d + 400); at(d + 500, completed); }
        else if (step.startsWith("__NOSTATUS__:")) { message(step.slice(13), d); at(d + 10, () => emit(sid, "agent.status", { activity_code: "online" })); }
        else {
          if (step.startsWith("__DROPLINK__:")) { reply = step.slice(13); at(20, () => link.close(new Error("dropped"))); }
          message(reply, d, { split: true }); at(d + 10, completed);
        }
        return { messageId, sessionId: sid };
      },
      async subscribe(sid, onEvent) {
        if (link.closed) throw new Error("Muse connection is closed");
        const chat = m.chats.get(sid);
        if (!chat) throw new MuseHttpError(404, "Muse /chat/subscribe");
        const set = subs.get(sid) ?? new Set();
        subs.set(sid, set);
        set.add(onEvent);
        onEvent(ev("task.status", { status: chat.status, task_id: "task-1", session_id: sid })); // replay, as the service does
        return { close: () => set.delete(onEvent), ended: Promise.resolve() };
      },
    };
    m.links.push(link);
    return link;
  };
  return m;
}
