// Portions Copyright (c) Meta Platforms, Inc. and affiliates. Licensed under the Apache License, Version 2.0
// (see LICENSE-APACHE). Ported to TypeScript and modified for Muse Bridge.
//
// The encrypted channel to a Muse VM, ported from the Muse Gadget SDK (linux/src/musegadget/noise, Apache-2.0):
// a Noise_XX_25519_AESGCM_SHA256 handshake, then HTTP-like request/response frames wrapped in small protobuf
// envelopes and split into Noise-sized chunks.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";

// ---------- protobuf wire helpers (only what the envelopes use) ----------

const WIRE_VARINT = 0, WIRE_FIXED64 = 1, WIRE_DELIMITED = 2, WIRE_FIXED32 = 5;
const U64 = (1n << 64n) - 1n;

function varint(value: bigint): number[] {
  if (value < 0n) value &= U64; // two's complement, as protobuf encodes negative int64
  const out: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

class ProtoWriter {
  private parts: number[] = [];
  private key(field: number, wire: number) { this.parts.push(...varint(BigInt((field << 3) | wire))); }
  int(field: number, value: number | bigint) { this.key(field, WIRE_VARINT); this.parts.push(...varint(BigInt(value))); return this; }
  bytes(field: number, value: Uint8Array) {
    this.key(field, WIRE_DELIMITED); this.parts.push(...varint(BigInt(value.length)));
    for (const b of value) this.parts.push(b);
    return this;
  }
  string(field: number, value: string) { return this.bytes(field, Buffer.from(value, "utf8")); }
  done(): Buffer { return Buffer.from(this.parts); }
}

// Iterates the fields of one message: [field number, wire type, varint value or delimited bytes].
function* fields(data: Buffer): Generator<[number, number, bigint, Buffer]> {
  let off = 0;
  const readVarint = (): bigint => {
    let value = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (off >= data.length) throw new Error("protobuf: truncated varint");
      const b = data[off++];
      value |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return value;
      shift += 7n;
    }
    throw new Error("protobuf: malformed varint");
  };
  while (off < data.length) {
    const key = readVarint();
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === WIRE_VARINT) yield [field, wire, readVarint(), Buffer.alloc(0)];
    else if (wire === WIRE_DELIMITED) {
      const len = Number(readVarint());
      if (off + len > data.length) throw new Error("protobuf: truncated field");
      yield [field, wire, 0n, data.subarray(off, off + len)];
      off += len;
    } else if (wire === WIRE_FIXED64) off += 8;
    else if (wire === WIRE_FIXED32) off += 4;
    else throw new Error("protobuf: bad wire type");
  }
}

const toInt64 = (v: bigint) => (v >= 1n << 63n ? v - (1n << 64n) : v);

// ---------- Noise XX ----------

const PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256";
const DH_LEN = 32, TAG_LEN = 16;

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

function hkdf2(ck: Buffer, ikm: Buffer): [Buffer, Buffer] {
  const temp = hmac(ck, ikm);
  const out1 = hmac(temp, Buffer.from([1]));
  return [out1, hmac(temp, Buffer.concat([out1, Buffer.from([2])]))];
}

export class CipherState {
  private nonce = 0n;
  private key?: Buffer;
  constructor(key?: Buffer) { this.key = key; }

  private iv(): Buffer {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.nonce++, 4);
    return iv;
  }
  encrypt(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.key) return plaintext;
    const c = createCipheriv("aes-256-gcm", this.key, this.iv());
    c.setAAD(ad);
    return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  }
  decrypt(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.key) return ciphertext;
    if (ciphertext.length < TAG_LEN) throw new Error("noise: ciphertext too short");
    const d = createDecipheriv("aes-256-gcm", this.key, this.iv());
    d.setAAD(ad);
    d.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LEN));
    return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - TAG_LEN)), d.final()]);
  }
}

interface KeyPair { priv: KeyObject; pub: Buffer }

function keyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { priv: privateKey, pub: Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url") };
}

function dh(priv: KeyObject, pub: Buffer): Buffer {
  if (pub.length !== DH_LEN) throw new Error("noise: bad public key length");
  const key = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: pub.toString("base64url") }, format: "jwk" });
  const shared = diffieHellman({ privateKey: priv, publicKey: key }); // Node rejects low-order points itself
  if (shared.every((b) => b === 0)) throw new Error("noise: DH produced all zeros");
  return shared;
}

class SymmetricState {
  h: Buffer;
  ck: Buffer;
  cipher = new CipherState();
  constructor() {
    const name = Buffer.alloc(32);
    name.write(PROTOCOL_NAME);
    this.h = this.ck = name;
    this.mixHash(Buffer.alloc(0));
  }
  mixHash(data: Buffer) { this.h = sha256(this.h, data); }
  mixKey(ikm: Buffer) {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cipher = new CipherState(k);
  }
  encryptAndHash(p: Buffer) { const c = this.cipher.encrypt(this.h, p); this.mixHash(c); return c; }
  decryptAndHash(c: Buffer) { const p = this.cipher.decrypt(this.h, c); this.mixHash(c); return p; }
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, Buffer.alloc(0));
    return [new CipherState(k1), new CipherState(k2)];
  }
}

/** Initiator side of Noise XX. The static key is fresh per connection: the bearer token authenticates us. */
export class NoiseXXInitiator {
  private ss = new SymmetricState();
  private e = keyPair();
  private re?: Buffer;

  message1(): Buffer {
    this.ss.mixHash(this.e.pub);
    this.ss.encryptAndHash(Buffer.alloc(0));
    return this.e.pub;
  }
  readMessage2(msg: Buffer) {
    if (msg.length < DH_LEN + DH_LEN + TAG_LEN + TAG_LEN) throw new Error("noise: message 2 too short");
    this.re = msg.subarray(0, DH_LEN);
    this.ss.mixHash(this.re);
    this.ss.mixKey(dh(this.e.priv, this.re));
    const rs = this.ss.decryptAndHash(msg.subarray(DH_LEN, DH_LEN * 2 + TAG_LEN));
    this.ss.mixKey(dh(this.e.priv, rs));
    this.ss.decryptAndHash(msg.subarray(DH_LEN * 2 + TAG_LEN));
  }
  message3(): Buffer {
    const s = keyPair();
    const encS = this.ss.encryptAndHash(s.pub);
    this.ss.mixKey(dh(s.priv, this.re!));
    return Buffer.concat([encS, this.ss.encryptAndHash(Buffer.alloc(0))]);
  }
  /** [send, receive] */
  split(): [CipherState, CipherState] { return this.ss.split(); }
}

// ---------- envelopes ----------

export interface Header { key: string; value: string }
export type Frame =
  | { kind: "response"; streamId: number; status: number; headers: Header[]; data: Buffer; end: boolean }
  | { kind: "body_chunk"; streamId: number; data: Buffer; end: boolean }
  | { kind: "reset"; streamId: number; code: number; reason: string };

const MAX_CHUNK_PAYLOAD = 65489;
const MAX_TOTAL_CHUNKS = 256;
const SERVICE_DAEMON = 0;

function headerBytes(h: Header) { return new ProtoWriter().string(1, h.key).string(2, h.value).done(); }

function decodeHeaders(raw: Buffer[]): Header[] {
  return raw.map((b) => {
    const h = { key: "", value: "" };
    for (const [f, , , bytes] of fields(b)) { if (f === 1) h.key = bytes.toString("utf8"); else if (f === 2) h.value = bytes.toString("utf8"); }
    return h;
  });
}

function decodeServiceFrame(data: Buffer): Frame | undefined {
  let streamId = 0, frame: Frame | undefined;
  for (const [f, , v, bytes] of fields(data)) {
    if (f === 1) streamId = Number(toInt64(v));
    else if (f === 3) { // ApplicationResponse
      let status = 0, body = Buffer.alloc(0), end = false;
      const headers: Buffer[] = [];
      for (const [g, , gv, gb] of fields(bytes)) {
        if (g === 1) status = Number(toInt64(gv)); else if (g === 2) headers.push(gb); else if (g === 3) body = gb; else if (g === 4) end = gv !== 0n;
      }
      frame = { kind: "response", streamId: 0, status, headers: decodeHeaders(headers), data: body, end };
    } else if (f === 4) { // BodyChunk
      let body = Buffer.alloc(0), end = false;
      for (const [g, , gv, gb] of fields(bytes)) { if (g === 1) body = gb; else if (g === 2) end = gv !== 0n; }
      frame = { kind: "body_chunk", streamId: 0, data: body, end };
    } else if (f === 5) { // Reset
      let code = 0, reason = "";
      for (const [g, , gv, gb] of fields(bytes)) { if (g === 1) code = Number(gv); else if (g === 2) reason = gb.toString("utf8"); }
      frame = { kind: "reset", streamId: 0, code, reason };
    }
  }
  if (frame) frame.streamId = streamId;
  return frame;
}

/** Encrypted request/response streams over an established Noise session. */
export class NoiseTransport {
  private nextStreamId = 1;
  private pending = new Map<bigint, { total: number; chunks: Map<number, Buffer>; at: number }>();

  private send: CipherState;
  private recv: CipherState;
  constructor(send: CipherState, recv: CipherState) { this.send = send; this.recv = recv; }

  /** Frames for a new request stream; `end` closes the request body. */
  request(verb: string, path: string, body: Buffer, headers: Header[], end: boolean): { streamId: number; frames: Buffer[] } {
    const streamId = this.nextStreamId++;
    const req = new ProtoWriter().string(1, verb).string(2, path);
    for (const h of headers) req.bytes(3, headerBytes(h));
    if (body.length) req.bytes(4, body);
    if (end) req.int(5, 1);
    return { streamId, frames: this.wrap(new ProtoWriter().int(1, streamId).bytes(2, req.done()).done()) };
  }
  bodyChunk(streamId: number, data: Buffer, end: boolean): Buffer[] {
    const chunk = new ProtoWriter();
    if (data.length) chunk.bytes(1, data);
    if (end) chunk.int(2, 1);
    return this.wrap(new ProtoWriter().int(1, streamId).bytes(4, chunk.done()).done());
  }
  reset(streamId: number, reason: string): Buffer[] {
    const r = new ProtoWriter().int(1, 1 /* CANCELLED */).string(2, reason).done();
    return this.wrap(new ProtoWriter().int(1, streamId).bytes(5, r).done());
  }

  private wrap(serviceFrame: Buffer): Buffer[] {
    const request = new ProtoWriter(); // ServiceRequest{service=DAEMON (default, omitted), payload}
    if (SERVICE_DAEMON) request.int(1, SERVICE_DAEMON);
    const payload = request.bytes(2, serviceFrame).done();
    const total = Math.max(1, Math.ceil(payload.length / MAX_CHUNK_PAYLOAD));
    if (total > MAX_TOTAL_CHUNKS) throw new Error(`message too large for the Muse channel (${payload.length} bytes)`);
    const chunkId = randomBytes(8).readBigInt64BE();
    const out: Buffer[] = [];
    for (let i = 0; i < total; i++) {
      const frame = new ProtoWriter().int(1, chunkId);
      if (i) frame.int(2, i);
      frame.int(3, total).bytes(4, payload.subarray(i * MAX_CHUNK_PAYLOAD, (i + 1) * MAX_CHUNK_PAYLOAD));
      out.push(this.send.encrypt(Buffer.alloc(0), frame.done()));
    }
    return out;
  }

  /** Decrypt one WebSocket message; undefined until a chunked frame is complete. */
  decrypt(ciphertext: Buffer): Frame | undefined {
    const plain = this.recv.decrypt(Buffer.alloc(0), ciphertext);
    let chunkId = 0n, index = 0, total = 1, payload = Buffer.alloc(0);
    for (const [f, , v, b] of fields(plain)) {
      if (f === 1) chunkId = toInt64(v); else if (f === 2) index = Number(v); else if (f === 3) total = Number(v); else if (f === 4) payload = b;
    }
    if (total < 1 || total > MAX_TOTAL_CHUNKS || index >= total) throw new Error("noise: bad chunk header");
    let whole: Buffer | undefined = payload;
    if (total > 1) {
      const now = Date.now();
      for (const [id, a] of this.pending) if (now - a.at > 60_000) this.pending.delete(id);
      const a = this.pending.get(chunkId) ?? { total, chunks: new Map(), at: now };
      this.pending.set(chunkId, a);
      a.chunks.set(index, Buffer.from(payload));
      whole = undefined;
      if (a.chunks.size === a.total) {
        this.pending.delete(chunkId);
        whole = Buffer.concat([...Array(a.total).keys()].map((i) => a.chunks.get(i)!));
      }
    }
    if (!whole) return undefined;
    let inner = Buffer.alloc(0); // ServiceResponse{payload}
    for (const [f, , , b] of fields(whole)) if (f === 1) inner = b;
    if (!inner.length) throw new Error("noise: empty ServiceResponse");
    return decodeServiceFrame(inner);
  }
}
