// Portions Copyright (c) Meta Platforms, Inc. and affiliates. Licensed under the Apache License, Version 2.0
// (see LICENSE-APACHE). Ported to TypeScript and modified for Muse Bridge.
//
// Pairing this computer as a Muse gadget, ported from the Muse Gadget SDK (linux/src/musegadget: pairing.py,
// ble_setup.py, ble_framing.py, pair.py; Apache-2.0). The Muse phone app finds the computer over Bluetooth, runs
// an encrypted handshake with it (protocol v5, community mode), and hands over device tokens. The Bluetooth radio
// is driven by a tiny native helper (ble-helper.swift); everything else happens here.
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_API, fetchVms, type Vm } from "./link.ts";

// ---------- device identity ----------

/** A random, locally administered MAC-shaped id, made once and kept; the names derive from its last 6 hex digits. */
export interface Identity { mac: string; nodeId: string; deviceId: string; bleName: string }

export function identityFrom(mac: string): Identity {
  const suffix = mac.replace(/:/g, "").slice(-6);
  return { mac, nodeId: `homelink-${suffix}`, deviceId: `hatch-link:${mac}`, bleName: `MuseGadget${suffix.toUpperCase()}` };
}

export function loadOrCreateIdentity(file: string): Identity {
  try {
    const mac = JSON.parse(readFileSync(file, "utf8")).mac;
    if (typeof mac === "string" && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) return identityFrom(mac);
  } catch {}
  const b = randomBytes(6);
  b[0] = (b[0] & 0xfc) | 0x02; // unicast, locally administered
  const mac = [...b].map((x) => x.toString(16).padStart(2, "0")).join(":");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file + ".tmp", JSON.stringify({ mac }) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
  return identityFrom(mac);
}

export const SDK_TOKEN_RE = /^mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

// ---------- BLE framing: 0xFE, chunk index, chunk count, fragment ----------

const CHUNK_MAGIC = 0xfe, MAX_PACKET = 160, MAX_MESSAGE = 8192;

export function encodeChunks(data: Buffer, mtu: number): Buffer[] {
  const usable = Math.min(mtu > 3 ? mtu - 3 : 20, MAX_PACKET) - 3;
  const out: Buffer[] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(data.length / usable)); i++) out.push(data.subarray(i * usable, (i + 1) * usable));
  if (out.length > 255) throw new Error("pairing message too large");
  return out.map((frag, i) => Buffer.concat([Buffer.from([CHUNK_MAGIC, i, out.length]), frag]));
}

export class ChunkAssembler {
  private buf: Buffer[] = [];
  private size = 0;
  private total = 0;
  private next = 0;
  reset() { this.buf = []; this.size = 0; this.total = 0; this.next = 0; }
  /** A complete message, or undefined while one is still arriving. Unframed writes are whole messages. */
  feed(p: Buffer): Buffer | undefined {
    if (p.length < 3 || p[0] !== CHUNK_MAGIC) return p;
    const index = p[1], total = p[2], frag = p.subarray(3);
    if (total === 0) { this.reset(); return undefined; }
    if (index === 0 || total !== this.total) { this.reset(); this.total = total; }
    if (index !== this.next || index >= this.total || this.size + frag.length > MAX_MESSAGE) { this.reset(); return undefined; }
    this.buf.push(frag); this.size += frag.length; this.next = index + 1;
    if (this.next < this.total) return undefined;
    const msg = Buffer.concat(this.buf);
    this.reset();
    return msg;
  }
}

// ---------- the encrypted pairing session (protocol v5, community mode) ----------

const PAIRING_VERSION = 5, MODEL = "hatch_link", SUITE = "p256-hkdf-sha256-aes-gcm-v1", POLICY = "confirm_app", AUTH = "none";
const RECORD_LABEL = "hatch-link ble setup v1", SESSION_ID_LABEL = "hatch-link session id v1";
const TO_DEVICE = 0, FROM_DEVICE = 1;

const b64u = (b: Buffer) => b.toString("base64url");
function unb64u(text: unknown, max = 4096): Buffer {
  if (typeof text !== "string" || !text.length || text.length > max || text.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("bad base64url");
  return Buffer.from(text, "base64url");
}
const hkdfExpand = (prk: Buffer, info: string) => createHmac("sha256", prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
const recordNonce = (dir: number, counter: bigint) => { const n = Buffer.alloc(12); n[0] = dir; n.writeBigUInt64BE(counter, 4); return n; };
const recordAad = (sid: string, dir: number, counter: bigint) => Buffer.from(`${RECORD_LABEL}|${sid}|${dir === TO_DEVICE ? "m2d" : "d2m"}|${counter}`);

type PairState = "idle" | "wait_finished" | "ready" | "provisioning";

export class PairingSession {
  state: PairState = "idle";
  private rxKey?: Buffer;
  private txKey?: Buffer;
  private sid = "";
  private rx = 0n;
  private tx = 0n;
  private deadline = 0;
  private id: Identity;
  private version: string;
  private sdkToken: string;

  constructor(id: Identity, version: string, sdkToken: string) { this.id = id; this.version = version; this.sdkToken = sdkToken; }

  deviceInfo() {
    return { device_id: this.id.deviceId, mac: this.id.mac, model: MODEL, pairing_protocol: PAIRING_VERSION, pairing_auth: AUTH, pairing_auth_epoch: 0, pairing_policy: POLICY };
  }

  get active(): boolean { this.expire(); return this.state !== "idle"; }
  get confirmed(): boolean { this.expire(); return this.state === "ready" || this.state === "provisioning"; }

  reset() { this.state = "idle"; this.rxKey = this.txKey = undefined; this.sid = ""; this.rx = this.tx = 0n; this.deadline = 0; }

  private expire() { if (this.state !== "idle" && Date.now() > this.deadline) this.reset(); }

  /** pairing_client_hello -> pairing_ready. Throws "error_pairing_invalid_hello". */
  hello(m: any): Record<string, unknown> {
    if (m.version !== PAIRING_VERSION || m.pairing_auth !== AUTH || m.pairing_policy !== POLICY) throw new Error("error_pairing_invalid_hello");
    this.reset();
    let mobilePub: Buffer, mobileNonce: Buffer;
    const ecdh = createECDH("prime256v1");
    let secret: Buffer;
    try {
      mobilePub = unb64u(m.mobile_pub); mobileNonce = unb64u(m.mobile_nonce);
      if (mobilePub.length !== 65 || mobilePub[0] !== 0x04 || mobileNonce.length !== 16) throw new Error();
      ecdh.generateKeys();
      secret = ecdh.computeSecret(mobilePub);
    } catch { throw new Error("error_pairing_invalid_hello"); }
    const devicePub = ecdh.getPublicKey();
    const deviceNonce = randomBytes(16);
    const transcript = [
      `hatch-link-pairing-v${PAIRING_VERSION}`, `version=${PAIRING_VERSION}`, "initiator_role=mobile", "responder_role=link",
      `device_id=${this.id.deviceId}`, `node_id=${this.id.nodeId}`, `mac=${this.id.mac}`, `model=${MODEL}`,
      `firmware_version=${this.version}`, `selected_cipher_suite=${SUITE}`, `pairing_auth=${AUTH}`, "pairing_auth_epoch=0",
      `pairing_policy=${POLICY}`, "confirm_timeout_seconds=0", `mobile_pub=${b64u(mobilePub)}`, `device_pub=${b64u(devicePub)}`,
      `mobile_nonce=${b64u(mobileNonce)}`, `device_nonce=${b64u(deviceNonce)}`,
    ].join("\n");
    const th = createHash("sha256").update(transcript).digest();
    const salt = createHash("sha256").update(Buffer.concat([mobileNonce, deviceNonce, th])).digest();
    const sessionSecret = Buffer.from(hkdfSync("sha256", secret, salt, RECORD_LABEL, 32));
    this.rxKey = hkdfExpand(sessionSecret, "mobile->device");
    this.txKey = hkdfExpand(sessionSecret, "device->mobile");
    this.sid = b64u(createHash("sha256").update(Buffer.concat([Buffer.from(SESSION_ID_LABEL), th, secret])).digest().subarray(0, 16));
    this.state = "wait_finished";
    this.deadline = Date.now() + 60_000;
    return {
      type: "pairing_ready", version: PAIRING_VERSION, device_id: this.id.deviceId, node_id: this.id.nodeId, mac: this.id.mac,
      model: MODEL, firmware_version: this.version, pairing_auth: AUTH, pairing_auth_epoch: 0, pairing_policy: POLICY,
      device_pub: b64u(devicePub), device_nonce: b64u(deviceNonce), transcript_hash: b64u(th), session_id: this.sid,
    };
  }

  /** Open one phone-to-device record. Any failure clears the session. Throws "error_pairing_decrypt". */
  decrypt(env: any): string {
    this.expire();
    try {
      if (this.state === "idle" || env.session_id !== this.sid) throw new Error();
      if (typeof env.counter !== "string" || !/^[0-9]+$/.test(env.counter) || BigInt(env.counter) !== this.rx) throw new Error();
      const ct = unb64u(env.ciphertext, 16384), tag = unb64u(env.tag);
      if (tag.length !== 16) throw new Error();
      const d = createDecipheriv("aes-256-gcm", this.rxKey!, recordNonce(TO_DEVICE, this.rx));
      d.setAAD(recordAad(this.sid, TO_DEVICE, this.rx));
      d.setAuthTag(tag);
      const plain = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
      this.rx++;
      return plain;
    } catch {
      this.reset();
      throw new Error("error_pairing_decrypt");
    }
  }

  /** The app already asked the user, so a valid first record confirms the session. */
  finished(cmd: any): boolean {
    this.expire();
    const ok = JSON.stringify(cmd) === '{"action":"pairing_client_finished"}' && this.state === "wait_finished" && this.rx === 1n;
    if (!ok) { this.reset(); return false; }
    this.state = "ready";
    this.deadline = Date.now() + 120_000;
    return true;
  }

  startProvisioning(): boolean {
    this.expire();
    if (this.state === "ready") this.state = "provisioning";
    if (this.state !== "provisioning") return false;
    this.deadline = Date.now() + 120_000;
    return true;
  }

  seal(obj: Record<string, unknown>): Record<string, unknown> | undefined {
    this.expire();
    if (this.state === "idle") return undefined;
    const c = createCipheriv("aes-256-gcm", this.txKey!, recordNonce(FROM_DEVICE, this.tx));
    c.setAAD(recordAad(this.sid, FROM_DEVICE, this.tx));
    const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
    const env = { type: "pairing_encrypted", session_id: this.sid, counter: String(this.tx), ciphertext: b64u(ct), tag: b64u(c.getAuthTag()) };
    this.tx++;
    return env;
  }

  status(status: string): Record<string, unknown> | undefined {
    const msg: Record<string, unknown> = { type: "status", status };
    if (status === "pairing_confirmed") msg.sdk_token = this.sdkToken; // Muse records the device's SDK token here
    return this.seal(msg);
  }
}

// ---------- setup commands (what the GATT characteristics carry) ----------

export interface Provisioned {
  access: string;
  refresh: string;
  username: string;
  apiUrl: string;
  noiseHost: string;
  vms: Vm[];
}

const SENSITIVE = new Set(["provision", "provision_v2", "wifi_scan", "ota", "device.ota", "unpair", "set_wifi", "set_auth"]);
const PLAINTEXT_STATUSES = new Set(["error_encryption_required", "error_pairing_invalid_hello", "error_pairing_unavailable", "error_pairing_decrypt"]);

export interface SetupTransport { sendPackets(p: Buffer[]): void; mtu(): number }

/**
 * Handles one phone at a time, in arrival order. `verify` checks the delivered tokens with Muse; `onProgress`
 * reports milestones; `onProvisioned` fires once the tokens are verified (before auth_ok is sent).
 */
export class SetupController {
  private assembler = new ChunkAssembler();
  private plaintextBlocked = false;
  private provisioning = false;
  private queue: Promise<void> = Promise.resolve();
  private session: PairingSession;
  private transport: SetupTransport;
  private id: Identity;
  private version: string;
  private verify: (c: Omit<Provisioned, "vms">) => Promise<Vm[]>;
  private onProgress: (m: string) => void;
  private onProvisioned: (p: Provisioned) => void;

  constructor(o: { session: PairingSession; transport: SetupTransport; identity: Identity; version: string;
    verify: (c: Omit<Provisioned, "vms">) => Promise<Vm[]>; onProgress: (m: string) => void; onProvisioned: (p: Provisioned) => void }) {
    this.session = o.session; this.transport = o.transport; this.id = o.identity; this.version = o.version;
    this.verify = o.verify; this.onProgress = o.onProgress; this.onProvisioned = o.onProvisioned;
  }

  onWrite(packet: Buffer) {
    const msg = this.assembler.feed(packet);
    if (msg) this.queue = this.queue.then(() => this.handle(msg, false)).catch(() => {});
  }

  onDisconnect() {
    this.assembler.reset();
    this.plaintextBlocked = false;
    this.session.reset();
  }

  private sendJson(obj: unknown) { this.transport.sendPackets(encodeChunks(Buffer.from(JSON.stringify(obj)), this.transport.mtu())); }

  sendStatus(status: string) {
    const env = this.session.status(status);
    if (env) return this.sendJson(env);
    if (!this.plaintextBlocked && PLAINTEXT_STATUSES.has(status)) this.transport.sendPackets([Buffer.from(status)]);
  }

  private async handle(raw: Buffer, decrypted: boolean): Promise<void> {
    let cmd: any;
    try { cmd = JSON.parse(raw.toString("utf8")); } catch { return this.sendStatus("error_invalid_command"); }
    if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) return this.sendStatus("error_invalid_command");
    const action = typeof cmd.action === "string" ? cmd.action : "";

    if (!decrypted && action === "pairing_client_hello") {
      try {
        const ready = this.session.hello(cmd);
        this.plaintextBlocked = true;
        this.sendJson(ready);
        this.onProgress("Phone connected; confirm in the Muse app.");
      } catch (e: any) { this.sendStatus(e.message); }
    } else if (!decrypted && action === "pairing_encrypted") {
      let plain: string;
      try { plain = this.session.decrypt(cmd); } catch (e: any) { return this.sendStatus(e.message); }
      return this.handle(Buffer.from(plain), true);
    } else if (action === "get_device_info") {
      this.sendJson({ type: "device_info", node_id: this.id.nodeId, version: this.version, ...this.session.deviceInfo(), build_sha: "", network_ready: true });
    } else if (!decrypted && this.plaintextBlocked) {
      // ignored: everything after the hello must be encrypted
    } else if (!decrypted && SENSITIVE.has(action)) {
      this.sendStatus("error_encryption_required");
    } else if (decrypted && action === "pairing_client_finished") {
      if (this.session.finished(cmd)) { this.sendStatus("pairing_confirmed"); this.onProgress("Confirmed in the Muse app; waiting for the next step."); }
      else this.sendStatus("error_pairing_decrypt");
    } else if (decrypted && SENSITIVE.has(action) && !this.session.confirmed) {
      this.sendStatus("error_pairing_confirm_required");
    } else if (decrypted && action === "wifi_scan") {
      // This computer is already online: offer one open "network" so the app skips the password.
      this.sendJson(this.session.seal({ type: "wifi_scan_result", networks: [{ ssid: "Use current connection", rssi: -40, secure: false }] }));
    } else if (decrypted && action === "provision_v2") {
      await this.provision(cmd);
    } else {
      this.sendStatus("error_unknown_action");
    }
  }

  private async provision(cmd: any) {
    const text = (k: string) => (typeof cmd[k] === "string" ? cmd[k] : "");
    if (typeof cmd.ssid !== "string" || typeof cmd.password !== "string" || !text("access_token") || !text("refresh_token") || text("token_type") !== "device") {
      return this.sendStatus("error_missing_credentials");
    }
    if (this.provisioning) return this.sendStatus("error_operation_in_progress");
    if (!this.session.startProvisioning()) return this.sendStatus("error_pairing_confirm_required");
    this.provisioning = true;
    try {
      this.sendStatus("wifi_connecting"); // the Wi-Fi fields are ignored: this computer is already online
      this.sendStatus("wifi_connected");
      this.onProgress("Received credentials; checking them with Muse...");
      const creds = {
        access: text("access_token"), refresh: text("refresh_token"), username: text("username"),
        apiUrl: text("api_url_v2").startsWith("https://") ? text("api_url_v2") : DEFAULT_API, noiseHost: text("noise_host"),
      };
      let vms: Vm[];
      try { vms = await this.verify(creds); } catch { vms = []; }
      if (!vms.length) return this.sendStatus("auth_failed");
      this.onProvisioned({ ...creds, vms });
      this.sendStatus("auth_ok");
    } finally {
      this.provisioning = false;
    }
  }
}

// ---------- the native Bluetooth helper ----------

const here = dirname(fileURLToPath(import.meta.url));
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.pi.musebridge.ble</string>
<key>CFBundleName</key><string>Muse Bridge Bluetooth helper</string>
<key>NSBluetoothAlwaysUsageDescription</key><string>Muse Bridge uses Bluetooth to pair this computer with your Muse.</string>
</dict></plist>
`;

/** Compile ble-helper.swift once per source version into `binDir`; returns the binary's path. */
export function ensureHelper(binDir: string, onProgress: (m: string) => void): string {
  if (process.platform !== "darwin") throw new Error("Pairing over Bluetooth is only supported on macOS for now.");
  const src = join(here, "ble-helper.swift");
  const hash = createHash("sha256").update(readFileSync(src)).update(INFO_PLIST).digest("hex").slice(0, 12);
  const bin = join(binDir, `musebridge-ble-${hash}`);
  if (existsSync(bin)) return bin;
  onProgress("Building the Bluetooth helper (first time only, about 10 seconds)...");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const plist = join(binDir, "Info.plist");
  writeFileSync(plist, INFO_PLIST);
  try {
    execFileSync("swiftc", ["-O", "-o", bin + ".tmp", src, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
  } catch (e: any) {
    const why = e?.code === "ENOENT" ? "the Swift compiler (swiftc) was not found" : String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-3).join(" ");
    throw new Error(`Could not build the Bluetooth helper: ${why}. Install Apple's Command Line Tools (xcode-select --install) and run /login again.`);
  }
  chmodSync(bin + ".tmp", 0o755);
  renameSync(bin + ".tmp", bin);
  return bin;
}

class BleHelper implements SetupTransport {
  private child: ChildProcessWithoutNullStreams;
  private mtuValue = MAX_PACKET + 3;
  constructor(bin: string, name: string, on: (ev: any) => void) {
    this.child = spawn(bin, [name], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.ev === "subscribed") this.mtuValue = ev.mtu;
      if (ev.ev === "unsubscribed") this.mtuValue = MAX_PACKET + 3;
      on(ev);
    });
    let stderr = "";
    this.child.stderr.on("data", (d) => (stderr += d));
    this.child.on("exit", (code, sig) => on({ ev: "exit", code, signal: sig, stderr }));
    this.child.on("error", (e) => on({ ev: "error", message: e.message }));
  }
  mtu() { return this.mtuValue; }
  sendPackets(packets: Buffer[]) { for (const p of packets) this.child.stdin.write(JSON.stringify({ op: "notify", data: p.toString("base64") }) + "\n"); }
  stop() { try { this.child.stdin.end(); } catch {} setTimeout(() => this.child.kill("SIGTERM"), 2000).unref(); }
}

// ---------- the whole flow ----------

export interface PairOptions {
  identity: Identity;
  sdkToken: string;
  version: string;
  binDir: string;
  signal: AbortSignal;
  timeoutMs?: number;
  notify: (kind: "info" | "progress", message: string) => void;
  /** Runs right after the tokens are verified and while the phone is still connected: register with Muse now. */
  afterProvisioned: (p: Provisioned) => Promise<void>;
}

/** Advertise until the Muse app pairs this computer; resolves with the device tokens. */
export async function pairOverBluetooth(o: PairOptions): Promise<Provisioned> {
  const bin = ensureHelper(o.binDir, (m) => o.notify("progress", m));
  return new Promise<Provisioned>((resolve, reject) => {
    let settled = false, provisioned: Provisioned | undefined;
    const session = new PairingSession(o.identity, o.version, o.sdkToken);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onAbort);
      setTimeout(() => helper.stop(), 1500); // let the last status reach the phone
      if (err) reject(err); else resolve(provisioned!);
    };
    const onAbort = () => finish(new Error("Pairing cancelled."));
    const timer = setTimeout(() => finish(new Error("Pairing timed out: the Muse app did not finish within 10 minutes. Run /login to try again.")), o.timeoutMs ?? 600_000);
    const helper = new BleHelper(bin, o.identity.bleName, (ev) => {
      if (ev.ev === "write") controller.onWrite(Buffer.from(ev.data, "base64"));
      else if (ev.ev === "subscribed") o.notify("progress", "The Muse app connected over Bluetooth...");
      else if (ev.ev === "unsubscribed") controller.onDisconnect();
      else if (ev.ev === "advertising") {
        o.notify("info", `Ready to pair. On your phone, in the Muse app: Settings > Devices, turn on Developer mode, tap Add Device (+), choose "${o.identity.bleName}", continue past the community-device notice, and pick the network it shows (no password needed). Keep this window open; it stays ready for 10 minutes.`);
      } else if (ev.ev === "state") {
        if (ev.state === "unauthorized") finish(new Error("macOS denied Bluetooth access. Allow it for your terminal app in System Settings > Privacy & Security > Bluetooth, then run /login again."));
        else if (ev.state === "poweredOff") finish(new Error("Bluetooth is off. Turn it on and run /login again."));
        else if (ev.state === "unsupported") finish(new Error("This computer's Bluetooth can't advertise (Bluetooth LE peripheral mode is unsupported)."));
        else if (ev.state === "unknown") o.notify("progress", "Waiting for Bluetooth (macOS may ask to allow Bluetooth access; click Allow)...");
      } else if (ev.ev === "error") finish(new Error(`Bluetooth: ${ev.message}`));
      else if (ev.ev === "exit" && !settled) finish(new Error(`The Bluetooth helper stopped unexpectedly${ev.stderr ? `: ${String(ev.stderr).trim().slice(0, 200)}` : ""}.`));
    });
    const controller = new SetupController({
      session, transport: helper, identity: o.identity, version: o.version,
      verify: (c) => fetchVms(c.access, c.apiUrl, o.signal),
      onProgress: (m) => o.notify("progress", m),
      onProvisioned: (p) => {
        provisioned = p;
        // Register right away, as the SDK's service does: the app only adds a device that comes online promptly.
        o.afterProvisioned(p).then(() => finish(), (e) => finish(e instanceof Error ? e : new Error(String(e))));
      },
    });
    o.signal.addEventListener("abort", onAbort, { once: true });
  });
}
