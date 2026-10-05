// Portions Copyright (c) Meta Platforms, Inc. and affiliates. Licensed under the Apache License, Version 2.0
// (see LICENSE-APACHE). Ported to TypeScript and modified for Muse Bridge.
//
// A Muse gadget's connection to its owner's Muse, ported from the Muse Gadget SDK's link_client.py and
// muse_api.py (Apache-2.0). The device finds its VM with its device token, opens the Noise channel, registers on
// a long-lived /link-control stream, and then makes HTTP-like requests (send a chat message, subscribe to a chat's events) on the same channel.
import { randomUUID } from "node:crypto";
import { type Frame, type Header, NoiseTransport, NoiseXXInitiator } from "./noise.ts";
import { WsClient } from "./ws.ts";

export const DEFAULT_API = "https://api.muse.ai";
export const DEFAULT_NOISE_HOST = "hatch.metaaivm.com";
const USER_AGENT = "pi-muse-bridge";
const APP_ID = "musegadget";
const HANDSHAKE_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_INLINE_REQUEST = 64 * 1024;
const REQUEST_CHUNK = 16 * 1024;
const MAX_CONTROL_MESSAGE = 4 * 1024 * 1024;

export class MuseHttpError extends Error {
  status: number;
  constructor(status: number, what: string, detail = "") {
    super(`${what} failed: HTTP ${status}${detail ? ` (${detail})` : ""}`);
    this.status = status;
  }
}

// ---------- device API (plain HTTPS) ----------

export interface Vm { vmId: string; vmName: string; vmUrl: string; vmToken: string; isDefault: boolean; state: string }

/** The VMs this device token may reach. A 401 means the token is no good. */
export async function fetchVms(accessToken: string, apiUrl = DEFAULT_API, signal?: AbortSignal): Promise<Vm[]> {
  const r = await fetch(apiUrl.replace(/\/$/, "") + "/fetch_vms", {
    headers: { Authorization: `Bearer ${accessToken}`, "X-API-Version": "1.0.0", "User-Agent": USER_AGENT }, signal,
  });
  if (!r.ok) throw new MuseHttpError(r.status, "Muse VM lookup");
  const data: any = await r.json();
  if (data?.error_title || data?.backend_error_code) throw new Error(`Muse VM lookup: ${data.error_title ?? ""} ${data.backend_error_code ?? ""}`.trim());
  return (Array.isArray(data?.vm_list) ? data.vm_list : [])
    .filter((v: any) => (v?.vm_ws_url || v?.vm_url) && v?.vm_auth_token)
    .map((v: any) => ({ vmId: v.vm_id ?? "", vmName: v.vm_name ?? "", vmUrl: v.vm_ws_url || v.vm_url, vmToken: v.vm_auth_token, isDefault: !!v.default, state: String(v.vm_state ?? "") }));
}

/**
 * Rotate the device token pair. The refresh token is presented with its scheme prefix, added once (apps may
 * already include it). A 401 means the pairing is gone and the device must be paired again.
 */
export async function refreshDeviceToken(refreshToken: string, deviceId: string, apiUrl = DEFAULT_API, sdkToken?: string, signal?: AbortSignal): Promise<{ access: string; refresh: string }> {
  const raw = refreshToken.split(":").pop();
  const body: any = { device_id: deviceId };
  if (sdkToken) body.sdk_token = sdkToken;
  const r = await fetch(apiUrl.replace(/\/$/, "") + "/device_token/refresh", {
    method: "POST", signal,
    headers: { Authorization: `Bearer hatch_refresh:${raw}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new MuseHttpError(r.status, "Muse device token refresh");
  let data: any = await r.json();
  if (data?.payload && typeof data.payload === "object") data = data.payload;
  if (!data?.access_token || !data?.refresh_token) throw new Error("Muse device token refresh: response had no tokens");
  return { access: data.access_token, refresh: data.refresh_token };
}

// ---------- the Noise session ----------

export interface Device {
  nodeId: string;
  displayName: string;
  version: string;
  commands?: Record<string, unknown>; // commands_v2; none means Muse can't run anything here
}

type StreamHandler = (frame: Frame) => void;

export interface ChatSubscription { close(): void; ended: Promise<void> }

/** One live connection. Create with MuseLink.connect(); it is registered when connect() resolves. */
export class MuseLink {
  private transport!: NoiseTransport;
  private controlStream = 0;
  private control = Buffer.alloc(0);
  private streams = new Map<number, StreamHandler>();
  private registerId = "";
  private registered!: { resolve: () => void; reject: (e: Error) => void };
  private closedWith?: Error;
  /** Called once when the connection ends, with the reason. */
  onClose?: (reason: Error) => void;

  private ws: WsClient;
  private constructor(ws: WsClient) { this.ws = ws; }

  static async connect(opts: { noiseHost: string; vm: Vm; device: Device; signal?: AbortSignal }): Promise<MuseLink> {
    const url = `wss://${opts.noiseHost}/v1/noise?vm_id=${encodeURIComponent(opts.vm.vmId || opts.vm.vmName)}`;
    // The Muse edge authenticates the upgrade with the VM bearer.
    const ws = await WsClient.connect(url, { Authorization: `Bearer ${opts.vm.vmToken}`, "User-Agent": USER_AGENT }, HANDSHAKE_TIMEOUT_MS);
    const link = new MuseLink(ws);
    const abort = () => link.close(new Error("aborted"));
    opts.signal?.addEventListener("abort", abort, { once: true });
    try {
      await withTimeout(link.handshake(), HANDSHAKE_TIMEOUT_MS, "Muse connection handshake");
      await withTimeout(link.register(opts.device), HANDSHAKE_TIMEOUT_MS, "Muse device registration");
      return link;
    } catch (e) {
      link.close(e as Error);
      throw e;
    } finally {
      opts.signal?.removeEventListener("abort", abort);
    }
  }

  get closed(): boolean { return !!this.closedWith; }

  private handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const noise = new NoiseXXInitiator();
      let ready = false;
      this.ws.onclose = (reason) => {
        const err = new Error(`Muse connection ended: ${reason}`);
        if (!ready) reject(err);
        this.fail(err);
      };
      this.ws.onmessage = (data) => {
        if (!ready) {
          try {
            noise.readMessage2(data);
            this.ws.send(noise.message3()); // empty payload: the bearer already authenticated us
            const [send, recv] = noise.split();
            this.transport = new NoiseTransport(send, recv);
            ready = true;
            resolve();
          } catch (e) { reject(e as Error); }
          return;
        }
        try {
          const frame = this.transport.decrypt(data);
          if (frame) this.dispatch(frame);
        } catch (e) { this.close(e as Error); }
      };
      this.ws.send(noise.message1());
    });
  }

  private register(device: Device): Promise<void> {
    const done = new Promise<void>((resolve, reject) => (this.registered = { resolve, reject }));
    const { streamId, frames } = this.transport.request("POST", "/link-control", Buffer.alloc(0), [], false);
    this.controlStream = streamId;
    this.streams.set(streamId, (f) => this.onControl(f));
    this.sendFrames(frames);
    this.registerId = randomUUID();
    this.sendControl({
      type: "req", id: this.registerId, method: "link.register",
      params: {
        node_id: device.nodeId, display_name: device.displayName, platform: "linux", version: device.version,
        device_family: "homehub", model_id: "linux", is_wakeup_supported: false, commands_v2: device.commands ?? {},
      },
    });
    return done;
  }

  private sendControl(message: unknown) {
    const json = Buffer.from(JSON.stringify(message), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(json.length);
    this.sendFrames(this.transport.bodyChunk(this.controlStream, Buffer.concat([len, json]), false));
  }

  private onControl(frame: Frame) {
    if (frame.kind === "reset") return this.close(new Error(`Muse control stream reset: ${frame.reason}`));
    if (frame.kind === "response" && frame.status >= 400) {
      const err = new MuseHttpError(frame.status, "Muse /link-control");
      this.registered?.reject(err);
      return this.close(err);
    }
    this.control = Buffer.concat([this.control, frame.data]);
    while (this.control.length >= 4) {
      const len = this.control.readUInt32LE(0);
      if (len > MAX_CONTROL_MESSAGE) return this.close(new Error("Muse control message too large"));
      if (this.control.length < 4 + len) break;
      const raw = this.control.subarray(4, 4 + len);
      this.control = this.control.subarray(4 + len);
      if (!raw.length) continue; // keepalive
      let msg: any;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { continue; }
      this.handleControl(msg);
    }
    if (frame.end) this.close(new Error("Muse ended the control stream"));
  }

  private handleControl(msg: any) {
    if (msg?.id === this.registerId && msg.method == null) {
      if (msg.error || msg.ok === false) this.registered.reject(new Error(`Muse refused the device registration: ${JSON.stringify(msg.error ?? msg).slice(0, 200)}`));
      else this.registered.resolve();
      return;
    }
    if (msg?.event === "link.unpaired" || msg?.event === "node.unpaired") {
      return this.close(Object.assign(new Error("This device was removed from your Muse. Run /login to pair it again."), { unpaired: true }));
    }
    if (msg?.method === "link.invoke" && msg.id) {
      // No commands are offered; answer anyway so Muse doesn't wait out its timeout.
      this.sendControl({ method: "link.result", id: msg.id, ok: false, error: "Muse Bridge offers no device commands" });
    }
  }

  private dispatch(frame: Frame) {
    this.streams.get(frame.streamId)?.(frame);
  }

  private sendFrames(frames: Buffer[]) {
    if (this.closedWith) throw this.closedWith;
    for (const f of frames) this.ws.send(f);
  }

  /** Start a request; frames for its stream go to `handler`. Large bodies are uploaded in parts. */
  private open(verb: string, path: string, body: Buffer, headers: Header[], handler: StreamHandler): number {
    const all = [...headers, { key: "x-request-id", value: randomUUID() }, { key: "x-app-id", value: APP_ID }];
    const inline = body.length <= MAX_INLINE_REQUEST;
    const { streamId, frames } = this.transport.request(verb, path, inline ? body : Buffer.alloc(0), all, inline);
    this.streams.set(streamId, handler);
    this.sendFrames(frames);
    if (!inline) {
      for (let off = 0; off < body.length; off += REQUEST_CHUNK) {
        this.sendFrames(this.transport.bodyChunk(streamId, body.subarray(off, off + REQUEST_CHUNK), off + REQUEST_CHUNK >= body.length));
      }
    }
    return streamId;
  }

  private cancel(streamId: number) {
    this.streams.delete(streamId);
    if (!this.closedWith) { try { this.sendFrames(this.transport.reset(streamId, "consumer closed")); } catch {} }
  }

  /** A complete request/response. */
  request(verb: string, path: string, json?: unknown, signal?: AbortSignal): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      if (this.closedWith) return reject(this.closedWith);
      let status = 0, body = Buffer.alloc(0), id = 0;
      const finish = (fn: () => void) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); this.streams.delete(id); this.pending.delete(onClose); fn(); };
      const onAbort = () => { this.cancel(id); finish(() => reject(new Error("aborted"))); };
      const onClose = (e: Error) => finish(() => reject(e));
      const timer = setTimeout(() => { this.cancel(id); finish(() => reject(new Error(`Muse ${path} timed out`))); }, REQUEST_TIMEOUT_MS);
      const headers = json === undefined ? [] : [{ key: "Content-Type", value: "application/json" }];
      const raw = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json), "utf8");
      try {
        id = this.open(verb, path, raw, headers, (f) => {
          if (f.kind === "reset") return finish(() => reject(new Error(`Muse ${path} stream reset: ${f.reason}`)));
          if (f.kind === "response") status = f.status;
          body = Buffer.concat([body, f.data]);
          if (f.end) finish(() => resolve({ status, body }));
        });
      } catch (e) { return finish(() => reject(e)); }
      this.pending.add(onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private pending = new Set<(e: Error) => void>();

  private async requestJson(verb: string, path: string, json?: unknown, signal?: AbortSignal): Promise<any> {
    const r = await this.request(verb, path, json, signal);
    const text = r.body.toString("utf8");
    if (r.status < 200 || r.status >= 300) throw new MuseHttpError(r.status, `Muse ${path}`, text.slice(0, 160));
    try { return text ? JSON.parse(text) : {}; } catch { throw new Error(`Muse ${path} returned non-JSON: ${text.slice(0, 120)}`); }
  }

  /** Post a user message as coming from this device. A new session_id starts a side chat; reusing one continues it. */
  async sendChat(message: string, sessionId: string, deviceId: string, signal?: AbortSignal): Promise<{ messageId: string; sessionId: string }> {
    const r = await this.requestJson("POST", "/chat/stream", { message, output_modality: "text", device_id: deviceId, session_id: sessionId }, signal);
    const ack = r?.response ?? r;
    if (!ack?.message_id) throw new Error(`Muse did not acknowledge the message: ${JSON.stringify(r).slice(0, 160)}`);
    return { messageId: ack.message_id, sessionId: ack.session_id ?? sessionId };
  }

  /**
   * Stream one side chat's events (NDJSON). The chat must exist (it does once its first message is sent).
   * Resolves once Muse accepted the subscription.
   */
  subscribe(sessionId: string, onEvent: (ev: any) => void): Promise<ChatSubscription> {
    return new Promise((resolve, reject) => {
      if (this.closedWith) return reject(this.closedWith);
      let buf = "", id = 0, accepted = false, endResolve!: () => void;
      const ended = new Promise<void>((r) => (endResolve = r));
      const stop = () => { this.pending.delete(onClose); this.streams.delete(id); endResolve(); };
      const onClose = (e: Error) => { stop(); if (!accepted) reject(e); };
      const body = Buffer.from(JSON.stringify({ session_id: sessionId }), "utf8");
      id = this.open("POST", "/chat/subscribe", body, [{ key: "Content-Type", value: "application/json" }, { key: "Accept", value: "application/x-ndjson" }], (f) => {
        if (f.kind === "reset") { stop(); if (!accepted) reject(new Error(`Muse chat subscription reset: ${f.reason}`)); return; }
        if (f.kind === "response") {
          if (f.status < 200 || f.status >= 300) { stop(); reject(new MuseHttpError(f.status, "Muse /chat/subscribe")); return; }
          accepted = true;
          resolve({ close: () => { this.cancel(id); stop(); }, ended });
        }
        buf += f.data.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { const ev = JSON.parse(line); if (ev?.type === "event") onEvent(ev); } catch {}
        }
        if (f.end) stop();
      });
      this.pending.add(onClose);
    });
  }

  close(reason: Error = new Error("closed")) {
    this.fail(reason);
    try { this.ws.close(reason.message); } catch {}
  }

  private fail(reason: Error) {
    if (this.closedWith) return;
    this.closedWith = reason;
    this.registered?.reject(reason);
    for (const p of [...this.pending]) p(reason);
    this.pending.clear();
    this.streams.clear();
    this.onClose?.(reason);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} timed out`)), ms)))]).finally(() => clearTimeout(timer));
}

/** The full text of a chat message event, whichever field carries it. */
export function eventText(ev: any): string {
  const p = ev?.payload && typeof ev.payload === "object" ? ev.payload : {};
  const t = ev?.display_text || p.display_text || (typeof p.content === "string" ? p.content : "") || (typeof ev?.content === "string" ? ev.content : "");
  return typeof t === "string" ? t : "";
}

export const eventName = (ev: any): string => ev?.event_name || ev?.event || ev?.payload?.event_name || "";
