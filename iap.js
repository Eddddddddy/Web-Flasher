// iap.js - 浏览器版 CH32M030 USB-CDC IAP 协议层。
// 移植自 scripts/iap_flash.py / ch32m030/bl/src/iap_proto.h。
// 帧: STX(0xA5) | CMD | LEN_LO | LEN_HI | PAYLOAD | CRC32_LE
// CRC32: IEEE 802.3 / zlib (poly 0xEDB88320)，覆盖 STX 到最后一个 payload 字节。

export const VID = 0x1a86;
export const PID = 0xfe0c;
const STX = 0xa5;
const RESP_FLAG = 0x80;
const CMD_HELLO = 0x01, CMD_ERASE = 0x02, CMD_WRITE = 0x03,
      CMD_CRC = 0x04, CMD_FINISH = 0x05, CMD_RESET = 0x06;
const STATUS_NAMES = { 0: 'OK', 1: 'BAD_FRAME', 2: 'BAD_PAYLOAD', 3: 'BAD_ADDR', 4: 'BAD_ALIGN', 5: 'FLASH_ERROR' };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function u32le(...vals) {
  const a = new Uint8Array(vals.length * 4);
  const dv = new DataView(a.buffer);
  vals.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return a;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

function buildFrame(cmd, payload = new Uint8Array(0)) {
  const body = new Uint8Array(4 + payload.length);
  body[0] = STX; body[1] = cmd;
  body[2] = payload.length & 0xff; body[3] = (payload.length >> 8) & 0xff;
  body.set(payload, 4);
  const crc = crc32(body);
  return concat(body, u32le(crc));
}

// 后台读取泵 + 阻塞式 read(n)，模拟 pyserial 的 read_exact。
class SerialIO {
  constructor(port) {
    this.port = port;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.buf = new Uint8Array(0);
    this.closed = false;
    this.err = null;
    this._pump();
  }
  async _pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) this.buf = concat(this.buf, value);
      }
    } catch (e) { this.err = e; }
    this.closed = true;
  }
  async read(n, timeout) {
    const dl = performance.now() + timeout;
    while (this.buf.length < n) {
      if (performance.now() > dl) throw new Error(`读取超时 (${n} 字节)`);
      if (this.closed) throw this.err || new Error('串口已关闭');
      await sleep(4);
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
  async huntStx(timeout) {
    const dl = performance.now() + timeout;
    while (performance.now() < dl) {
      const b = await this.read(1, timeout);
      if (b[0] === STX) return;
    }
    throw new Error('等待 STX 超时');
  }
  async write(bytes) { await this.writer.write(bytes); }
  async close() {
    try { await this.reader.cancel(); } catch {}
    try { this.reader.releaseLock(); } catch {}
    try { await this.writer.close(); } catch {}
    try { this.writer.releaseLock(); } catch {}
  }
}

async function recvReply(io, expectCmd, timeout) {
  await io.huntStx(timeout);
  const header = await io.read(4, timeout);           // cmd, status, len_lo, len_hi
  const plen = header[2] | (header[3] << 8);
  const payload = plen ? await io.read(plen, timeout) : new Uint8Array(0);
  const crcBytes = await io.read(4, timeout);
  const crcRx = (crcBytes[0] | crcBytes[1] << 8 | crcBytes[2] << 16 | crcBytes[3] << 24) >>> 0;
  const chk = new Uint8Array(1 + 4 + payload.length);
  chk[0] = STX; chk.set(header, 1); chk.set(payload, 5);
  if (crc32(chk) !== crcRx) throw new Error('回复 CRC 不匹配');
  if (header[0] !== ((expectCmd | RESP_FLAG) & 0xff)) throw new Error(`回复 CMD 异常 0x${header[0].toString(16)}`);
  return { status: header[1], payload };
}

async function transact(io, cmd, payload = new Uint8Array(0), timeout = 2000) {
  await io.write(buildFrame(cmd, payload));
  const { status, payload: reply } = await recvReply(io, cmd, timeout);
  if (status !== 0) throw new Error(`CMD 0x${cmd.toString(16)} 返回状态 ${STATUS_NAMES[status] || status}`);
  return reply;
}

async function hello(io) {
  const p = await transact(io, CMD_HELLO, new Uint8Array(0), 2500);
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return {
    protoVer: p[0],
    blVer: dv.getUint16(1, true),
    appBase: dv.getUint32(3, true),
    appLength: dv.getUint32(7, true),
    sentinelAddr: dv.getUint32(11, true),
    pageSize: dv.getUint32(15, true),
    progBlock: dv.getUint32(19, true),
    maxChunk: dv.getUint32(23, true),
  };
}

// 请求一个 CH32M030 CDC 端口（需用户手势触发）。
export function requestPort() {
  return navigator.serial.requestPort({ filters: [{ usbVendorId: VID, usbProductId: PID }] });
}

// App 运行态：发送 "iap" 让设备重启进入 bootloader。之后设备会重新枚举。
export async function enterIap(port, log = () => {}) {
  await port.open({ baudRate: 115200 });
  try {
    const w = port.writable.getWriter();
    await w.write(new TextEncoder().encode('iap\r\n'));
    w.releaseLock();
    log('已向 App 发送 iap，设备将重启进入升级模式…');
  } finally {
    try { await port.close(); } catch {}
  }
}

// 完整刷写流程：HELLO -> ERASE -> WRITE -> CRC 校验 -> FINISH。
export async function flash(port, image, { log = () => {}, onProgress = () => {} } = {}) {
  await port.open({ baudRate: 115200 });
  const io = new SerialIO(port);
  try {
    const info = await hello(io);
    log(`bootloader proto=${info.protoVer} ver=0x${info.blVer.toString(16)} ` +
        `app=[0x${info.appBase.toString(16)}, +0x${info.appLength.toString(16)}] block=${info.progBlock}`);
    if (image.length > info.appLength)
      throw new Error(`固件 ${image.length} 字节超出 App 容量 ${info.appLength} 字节`);

    const block = info.progBlock;
    const padLen = Math.ceil(image.length / block) * block;
    const padded = new Uint8Array(padLen).fill(0xff);
    padded.set(image);

    log(`擦除 0x${info.appBase.toString(16)} +${padLen} …`);
    await transact(io, CMD_ERASE, u32le(info.appBase, padLen), 8000);

    const total = padLen / block;
    for (let i = 0; i < total; i++) {
      const addr = info.appBase + i * block;
      const chunk = padded.subarray(i * block, (i + 1) * block);
      await transact(io, CMD_WRITE, concat(u32le(addr), chunk), 3000);
      onProgress((i + 1) / total);
    }

    log('校验设备端 CRC …');
    const r = await transact(io, CMD_CRC, u32le(info.appBase, padLen), 8000);
    const devCrc = new DataView(r.buffer, r.byteOffset, 4).getUint32(0, true) >>> 0;
    const hostCrc = crc32(padded);
    if (devCrc !== hostCrc)
      throw new Error(`CRC 不匹配 device=0x${devCrc.toString(16)} host=0x${hostCrc.toString(16)}`);
    log(`CRC OK 0x${hostCrc.toString(16)}`);

    log('置位 sentinel 并复位 …');
    try { await transact(io, CMD_FINISH, new Uint8Array(0), 3000); }
    catch { log('FINISH 已发送（设备复位中）'); }
    log('完成。设备已重启运行新固件。');
  } finally {
    await io.close();
    try { await port.close(); } catch {}
  }
}
