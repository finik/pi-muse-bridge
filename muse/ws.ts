// A small binary WebSocket client (RFC 6455) over an HTTPS upgrade. Node's built-in WebSocket sends fetch-style
// headers the Muse edge refuses, and cannot send pings; this one sends exactly what the SDK's client sends.
import { randomBytes, createHash } from "node:crypto";
import https from "node:https";
import type { Socket } from "node:net";

const PING_INTERVAL_MS = 20_000;

export class WsClient {
  onmessage?: (data: Buffer) => void;
  onclose?: (reason: string) => void;
  private socket!: Socket;
  private buf = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;
  private pinger?: NodeJS.Timeout;
  private lastSeen = Date.now();

  static connect(url: string, headers: Record<string, string>, timeoutMs: number): Promise<WsClient> {
    const u = new URL(url);
    const key = randomBytes(16).toString("base64");
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: u.hostname, port: u.port || 443, path: u.pathname + u.search, timeout: timeoutMs,
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, ...headers },
      });
      req.on("upgrade", (res, socket, head) => {
        const expect = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        if (res.headers["sec-websocket-accept"] !== expect) { socket.destroy(); return reject(new Error("Muse connection: bad WebSocket handshake")); }
        const ws = new WsClient();
        ws.attach(socket, head);
        resolve(ws);
      });
      req.on("response", (res) => {
        res.resume();
        reject(Object.assign(new Error(`Muse connection refused: HTTP ${res.statusCode}`), { status: res.statusCode }));
      });
      req.on("timeout", () => req.destroy(new Error("Muse connection timed out")));
      req.on("error", (e) => reject(new Error(`Muse connection failed: ${e.message}`)));
      req.end();
    });
  }

  private attach(socket: Socket, head: Buffer) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (d) => this.onData(d));
    socket.on("close", () => this.finish("connection closed"));
    socket.on("error", (e) => this.finish(`connection error: ${e.message}`));
    if (head.length) this.onData(head);
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastSeen > PING_INTERVAL_MS * 3) return this.close("no response to pings");
      this.writeFrame(0x9, Buffer.alloc(0));
    }, PING_INTERVAL_MS);
    this.pinger.unref();
  }

  send(data: Buffer) { this.writeFrame(0x2, data); }

  close(reason = "closed") {
    if (!this.closed) { try { this.writeFrame(0x8, Buffer.from([0x03, 0xe8])); } catch {} }
    this.finish(reason);
    this.socket?.end();
  }

  private finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    this.onclose?.(reason);
  }

  private writeFrame(opcode: number, payload: Buffer) {
    if (this.closed) throw new Error("Muse connection is closed");
    const len = payload.length;
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (len < 126) header[1] = 0x80 | len;
    else if (len < 65536) { header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private onData(chunk: Buffer) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 2) {
      const fin = (this.buf[0] & 0x80) !== 0, opcode = this.buf[0] & 0x0f, masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskKey = masked ? this.buf.subarray(off, off + 4) : undefined;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (maskKey) payload = Buffer.from(payload.map((b, i) => b ^ maskKey[i & 3]));
      if (opcode === 0x8) { this.close("closed by Muse"); return; }
      if (opcode === 0x9) { this.writeFrame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      this.fragments.push(Buffer.from(payload));
      if (fin) {
        const msg = Buffer.concat(this.fragments);
        this.fragments = [];
        this.onmessage?.(msg);
      }
    }
  }
}
