// iap.js - 浏览器版 CH32M030 USB-CDC IAP 协议层。
// 移植自 scripts/iap_flash.py / ch32m030/bl/src/iap_proto.h。
// 帧: STX(0xA5) | CMD | LEN_LO | LEN_HI | PAYLOAD | CRC32_LE
// CRC32: IEEE 802.3 / zlib (poly 0xEDB88320)，覆盖 STX 到最后一个 payload 字节。

export const VID = 0x1a86;
export const PID = 0xfe0c;
export const EXPECTED_PRODUCT_ID = 1;
export const EXPECTED_BOARD_ID = 1;
export const EXPECTED_PROFILE_ID = 1;
export const EXPECTED_PROTO_VERSION = 0x02;
export const MIN_VERIFIED_FINISH_BL_VERSION = 0x0105;
export const EXPECTED_APP_BASE = 0x00001800;
export const EXPECTED_APP_LENGTH = 0x0000e380;
export const EXPECTED_PROG_BLOCK = 128;
export const APP_MANIFEST_OFFSET = 0xc0;
export const APP_MANIFEST_SIZE = 16;
export const APP_MANIFEST_MAGIC = 0x4d414f53;
export const APP_MANIFEST_VERSION = 1;
const STX = 0xa5;
const RESP_FLAG = 0x80;
const MAX_REPLY_PAYLOAD = 4096;
const CMD_HELLO = 0x01, CMD_ERASE = 0x02, CMD_WRITE = 0x03,
      CMD_CRC = 0x04, CMD_FINISH = 0x05, CMD_RESET = 0x06;
const STATUS_NAMES = {
  0: 'OK',
  1: 'BAD_FRAME',
  2: 'BAD_PAYLOAD',
  3: 'BAD_ADDR',
  4: 'BAD_ALIGN',
  5: 'FLASH_ERROR',
  6: 'VERIFY_ERROR',
  7: 'IDENTITY_ERROR',
};

export class IapProtocolError extends Error {
  constructor(cmd, status) {
    super(`CMD 0x${cmd.toString(16)} 返回状态 ${STATUS_NAMES[status] || status}`);
    this.name = 'IapProtocolError';
    this.cmd = cmd;
    this.status = status;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
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
      const b = await this.read(1, Math.max(1, dl - performance.now()));
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
  if (plen > MAX_REPLY_PAYLOAD) throw new Error(`回复 payload 过长 (${plen} 字节)`);
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
  if (status !== 0) throw new IapProtocolError(cmd, status);
  return reply;
}

async function hello(io, timeout = 2500) {
  const p = await transact(io, CMD_HELLO, new Uint8Array(0), timeout);
  if (p.length !== 29) throw new Error(`HELLO payload 长度异常 (${p.length}，预期 29)`);
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
    productId: p[27],
    boardId: p[28],
  };
}

function isExpectedUsbPort(port) {
  if (!port || typeof port.getInfo !== 'function') return false;
  const usb = port.getInfo();
  return usb.usbVendorId === VID && usb.usbProductId === PID;
}

export function parseAppManifest(image) {
  if (!(image instanceof Uint8Array) || image.length < APP_MANIFEST_OFFSET + APP_MANIFEST_SIZE) {
    throw new Error('固件缺少固定 App manifest');
  }
  const dv = new DataView(image.buffer, image.byteOffset + APP_MANIFEST_OFFSET, APP_MANIFEST_SIZE);
  const manifest = {
    magic: dv.getUint32(0, true),
    manifestVersion: dv.getUint8(4),
    productId: dv.getUint8(5),
    boardId: dv.getUint8(6),
    profileId: dv.getUint8(7),
    firmwareVersionCode: dv.getUint32(8, true),
    reserved: dv.getUint32(12, true),
  };
  if (manifest.magic !== APP_MANIFEST_MAGIC ||
      manifest.manifestVersion !== APP_MANIFEST_VERSION) {
    throw new Error(
      `App manifest 无效：magic=0x${manifest.magic.toString(16)} ` +
      `version=${manifest.manifestVersion}`,
    );
  }
  if (manifest.profileId < 1 || manifest.profileId > 4 ||
      manifest.firmwareVersionCode === 0 || manifest.reserved !== 0) {
    throw new Error('App manifest 的 profile/version/reserved 字段无效');
  }
  return Object.freeze(manifest);
}

export function validatePenProductionManifest(manifest) {
  if (manifest.productId !== EXPECTED_PRODUCT_ID ||
      manifest.boardId !== EXPECTED_BOARD_ID ||
      manifest.profileId !== EXPECTED_PROFILE_ID) {
    throw new Error(
      `固件身份不兼容：product/board/profile=${manifest.productId}/` +
      `${manifest.boardId}/${manifest.profileId}，网页只允许 ` +
      `${EXPECTED_PRODUCT_ID}/${EXPECTED_BOARD_ID}/${EXPECTED_PROFILE_ID}`,
    );
  }
}

export function validateBootloaderInfo(info) {
  if (info.protoVer !== EXPECTED_PROTO_VERSION) {
    throw new Error(`IAP 协议版本不兼容：设备=${info.protoVer}，需要=${EXPECTED_PROTO_VERSION}`);
  }
  if (info.blVer < MIN_VERIFIED_FINISH_BL_VERSION) {
    throw new Error(
      `Bootloader 过旧：设备=0x${info.blVer.toString(16).padStart(4, '0')}，` +
      `最低需要=0x${MIN_VERIFIED_FINISH_BL_VERSION.toString(16).padStart(4, '0')}。` +
      '请先用 WCH-Link 烧录当前 combined.bin。',
    );
  }
  if (info.appBase !== EXPECTED_APP_BASE || info.appLength !== EXPECTED_APP_LENGTH) {
    throw new Error(
      `App 分区不兼容：设备=[0x${info.appBase.toString(16)}, +0x${info.appLength.toString(16)}]，` +
      `需要=[0x${EXPECTED_APP_BASE.toString(16)}, +0x${EXPECTED_APP_LENGTH.toString(16)}]。`,
    );
  }
  if (info.progBlock !== EXPECTED_PROG_BLOCK || info.maxChunk < EXPECTED_PROG_BLOCK) {
    throw new Error(
      `IAP 写入粒度不兼容：block=${info.progBlock} maxChunk=${info.maxChunk}，` +
      `需要 ${EXPECTED_PROG_BLOCK} 字节。`,
    );
  }
  if (info.productId !== EXPECTED_PRODUCT_ID || info.boardId !== EXPECTED_BOARD_ID) {
    throw new Error(
      `Bootloader 产品身份不兼容：设备=${info.productId}/${info.boardId}，` +
      `网页需要=${EXPECTED_PRODUCT_ID}/${EXPECTED_BOARD_ID}`,
    );
  }
}

function validateReleaseForDevice(release, info, imageLength, imageManifest) {
  validatePenProductionManifest(imageManifest);
  if (!release) return;
  if (release.size !== imageLength) throw new Error('固件大小与发布清单不一致');
  if (release.productId !== imageManifest.productId ||
      release.boardId !== imageManifest.boardId ||
      release.profileId !== imageManifest.profileId) {
    throw new Error('固件内嵌身份与发布清单不一致');
  }
  if (release.productId !== info.productId || release.boardId !== info.boardId) {
    throw new Error('发布清单产品身份与 Bootloader HELLO 不一致');
  }
  if (release.appBase !== info.appBase || release.appLength !== info.appLength ||
      release.progBlock !== info.progBlock) {
    throw new Error('固件发布清单与设备 App 分区不一致');
  }
  if (info.blVer < release.minBootloader) {
    throw new Error(
      `该固件要求 Bootloader >= 0x${release.minBootloader.toString(16).padStart(4, '0')}`,
    );
  }
}

// 请求一个 CH32M030 CDC 端口（需用户手势触发）。
export async function requestPort() {
  const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VID, usbProductId: PID }] });
  if (!isExpectedUsbPort(port)) {
    const usb = port.getInfo();
    throw new Error(
      `USB 设备身份不兼容：实际=${(usb.usbVendorId ?? 0).toString(16)}:` +
      `${(usb.usbProductId ?? 0).toString(16)}，需要=${VID.toString(16)}:${PID.toString(16)}`,
    );
  }
  return port;
}

// 在不触发浏览器授权弹窗的前提下确认端口确实是兼容的 Pen IAP。
// 该函数会短暂打开端口、完成 HELLO 和身份检查，然后释放端口供刷写阶段重新打开。
export async function probeIapPort(port, { timeoutMs = 1200 } = {}) {
  if (!isExpectedUsbPort(port)) {
    throw new Error('USB 端口不是受支持的 SolderingPen 设备');
  }
  if (port.connected === false) throw new Error('串口设备当前未连接');

  let io = null;
  await port.open({ baudRate: 115200 });
  try {
    io = new SerialIO(port);
    const info = await hello(io, timeoutMs);
    try {
      validateBootloaderInfo(info);
    } catch (error) {
      // HELLO 已成功返回：这是 IAP 设备，只是身份/版本不兼容，不能误当成 App 再发送 iap。
      error.iapHelloReceived = true;
      throw error;
    }
    return info;
  } finally {
    if (io) await io.close();
    try { await port.close(); } catch {}
  }
}

// 只扫描 navigator.serial.getPorts() 返回的已授权端口，不会主动弹出授权窗口。
// App 重启后若浏览器把权限继承给新的 IAP CDC，该函数会自动完成 HELLO；否则返回 null。
export async function waitForAuthorizedIap({
  serial = navigator.serial,
  timeoutMs = 15000,
  pollMs = 250,
  probeTimeoutMs = 900,
  log = () => {},
} = {}) {
  if (!serial || typeof serial.getPorts !== 'function') {
    throw new Error('当前浏览器不支持已授权串口枚举');
  }

  const deadline = performance.now() + timeoutMs;
  const lastProbeAt = new WeakMap();
  let announced = false;
  while (performance.now() < deadline) {
    const ports = await serial.getPorts();
    for (const port of ports) {
      if (!isExpectedUsbPort(port) || port.connected === false) continue;
      const now = performance.now();
      if (now - (lastProbeAt.get(port) ?? -Infinity) < 1000) continue;
      lastProbeAt.set(port, now);
      if (!announced) {
        log('检测到已授权串口，正在验证 IAP HELLO…');
        announced = true;
      }
      try {
        const info = await probeIapPort(port, { timeoutMs: probeTimeoutMs });
        return { port, info };
      } catch {
        // App CDC 也可能具有相同 VID/PID；等待它消失并由 IAP CDC 重新枚举。
      }
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - performance.now())));
  }
  return null;
}

// App 运行态：发送 "iap" 让设备重启进入 bootloader。之后设备会重新枚举。
export async function enterIap(port, log = () => {}) {
  await port.open({ baudRate: 115200 });
  try {
    const w = port.writable.getWriter();
    // probeIapPort() has just sent a binary HELLO frame to this App CDC.  The
    // App console ignores most binary bytes, but any printable CRC bytes remain
    // in its line buffer.  Terminate that partial line before sending the real
    // command, matching the proven host flasher's "\r\niap\r\n" sequence.
    await w.write(new TextEncoder().encode('\r\niap\r\n'));
    w.releaseLock();
    log('已向 App 发送完整的 iap 命令，等待设备复位并进入升级模式…');
  } finally {
    try { await port.close(); } catch {}
  }
}

// 完整刷写流程：HELLO -> ERASE -> WRITE -> CRC 校验 -> FINISH。
export async function flash(port, image,
                            { log = () => {}, onProgress = () => {}, release = null } = {}) {
  if (!(image instanceof Uint8Array) || image.length === 0) {
    throw new Error('固件为空或格式无效');
  }
  await port.open({ baudRate: 115200 });
  const io = new SerialIO(port);
  try {
    const imageManifest = parseAppManifest(image);
    validatePenProductionManifest(imageManifest);
    const info = await hello(io);
    log(`bootloader proto=${info.protoVer} ver=0x${info.blVer.toString(16)} ` +
        `product/board=${info.productId}/${info.boardId} ` +
        `app=[0x${info.appBase.toString(16)}, +0x${info.appLength.toString(16)}] block=${info.progBlock}`);
    validateBootloaderInfo(info);
    validateReleaseForDevice(release, info, image.length, imageManifest);
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

    log('验证 App manifest、置位 sentinel 并复位 …');
    await transact(io, CMD_FINISH, u32le(padLen, hostCrc), 3000);
    log('FINISH 已确认，Bootloader 已接受镜像并开始复位。');
  } finally {
    await io.close();
    try { await port.close(); } catch {}
  }
}
