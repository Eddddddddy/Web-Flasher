import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPECTED_APP_BASE,
  EXPECTED_APP_LENGTH,
  EXPECTED_PROG_BLOCK,
  APP_MANIFEST_OFFSET,
  APP_MANIFEST_MAGIC,
  APP_MANIFEST_VERSION,
  IapProtocolError,
  crc32,
  enterIap,
  flash,
  probeIapPort,
  waitForAuthorizedIap,
} from '../iap.js';

const STX = 0xa5;
const RESP_FLAG = 0x80;
const CMD_HELLO = 0x01;
const CMD_ERASE = 0x02;
const CMD_WRITE = 0x03;
const CMD_CRC = 0x04;
const CMD_FINISH = 0x05;

function u32le(...values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return bytes;
}

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function replyFrame(cmd, status = 0, payload = new Uint8Array(0)) {
  const body = new Uint8Array(5 + payload.length);
  body[0] = STX;
  body[1] = cmd | RESP_FLAG;
  body[2] = status;
  body[3] = payload.length & 0xff;
  body[4] = payload.length >>> 8;
  body.set(payload, 5);
  return concat(body, u32le(crc32(body)));
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset, true);
}

class FakeIapPort {
  constructor({
    protoVer = 2,
    blVer = 0x0105,
    appBase = EXPECTED_APP_BASE,
    appLength = EXPECTED_APP_LENGTH,
    progBlock = EXPECTED_PROG_BLOCK,
    maxChunk = EXPECTED_PROG_BLOCK,
    finishStatus = 0,
    productId = 1,
    boardId = 1,
  } = {}) {
    this.usbInfo = { usbVendorId: 0x1a86, usbProductId: 0xfe0c };
    this.connected = true;
    this.info = { protoVer, blVer, appBase, appLength, progBlock, maxChunk, productId, boardId };
    this.finishStatus = finishStatus;
    this.commands = [];
    this.finishPayload = null;
    this.memory = new Uint8Array(appLength).fill(0xff);
    this.readable = new ReadableStream({
      start: (controller) => { this.readController = controller; },
    });
    this.writable = new WritableStream({
      write: (frame) => this.handleRequest(new Uint8Array(frame)),
    });
  }

  async open(options) {
    assert.equal(options.baudRate, 115200);
  }

  async close() {}

  getInfo() { return this.usbInfo; }

  handleRequest(frame) {
    assert.equal(frame[0], STX);
    const cmd = frame[1];
    const length = frame[2] | (frame[3] << 8);
    const payload = frame.slice(4, 4 + length);
    assert.equal(readU32(frame, 4 + length), crc32(frame.slice(0, 4 + length)));
    this.commands.push(cmd);

    let status = 0;
    let response = new Uint8Array(0);
    if (cmd === CMD_HELLO) {
      response = concat(
        Uint8Array.of(this.info.protoVer),
        Uint8Array.of(this.info.blVer & 0xff, this.info.blVer >>> 8),
        u32le(
          this.info.appBase,
          this.info.appLength,
          0x0000fffc,
          1024,
          this.info.progBlock,
          this.info.maxChunk,
        ),
        Uint8Array.of(this.info.productId, this.info.boardId),
      );
    } else if (cmd === CMD_ERASE) {
      const offset = readU32(payload, 0) - this.info.appBase;
      const eraseLength = readU32(payload, 4);
      this.memory.fill(0xff, offset, offset + eraseLength);
    } else if (cmd === CMD_WRITE) {
      const offset = readU32(payload, 0) - this.info.appBase;
      this.memory.set(payload.slice(4), offset);
    } else if (cmd === CMD_CRC) {
      const offset = readU32(payload, 0) - this.info.appBase;
      const crcLength = readU32(payload, 4);
      response = u32le(crc32(this.memory.slice(offset, offset + crcLength)));
    } else if (cmd === CMD_FINISH) {
      this.finishPayload = payload;
      status = this.finishStatus;
    } else {
      status = 1;
    }
    this.readController.enqueue(replyFrame(cmd, status, response));
  }
}

function appImage(length = 209, { productId = 1, boardId = 1, profileId = 1 } = {}) {
  const image = Uint8Array.from({ length }, (_, index) => index & 0xff);
  const view = new DataView(image.buffer);
  view.setUint32(APP_MANIFEST_OFFSET, APP_MANIFEST_MAGIC, true);
  view.setUint8(APP_MANIFEST_OFFSET + 4, APP_MANIFEST_VERSION);
  view.setUint8(APP_MANIFEST_OFFSET + 5, productId);
  view.setUint8(APP_MANIFEST_OFFSET + 6, boardId);
  view.setUint8(APP_MANIFEST_OFFSET + 7, profileId);
  view.setUint32(APP_MANIFEST_OFFSET + 8, 0x00030000, true);
  view.setUint32(APP_MANIFEST_OFFSET + 12, 0, true);
  return image;
}

function releaseFor(image) {
  return {
    product: 'soldering-pen',
    board: 'pen_m030',
    profile: 'production',
    productId: 1,
    boardId: 1,
    profileId: 1,
    size: image.length,
    appBase: EXPECTED_APP_BASE,
    appLength: EXPECTED_APP_LENGTH,
    progBlock: EXPECTED_PROG_BLOCK,
    minBootloader: 0x0105,
  };
}

test('verified FINISH carries padded length and CRC after device CRC passes', async () => {
  const port = new FakeIapPort();
  const image = appImage();
  const progress = [];

  await flash(port, image, {
    release: releaseFor(image),
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(port.commands, [CMD_HELLO, CMD_ERASE, CMD_WRITE, CMD_WRITE, CMD_CRC, CMD_FINISH]);
  assert.equal(port.finishPayload.length, 8);
  assert.equal(readU32(port.finishPayload, 0), 256);
  const padded = new Uint8Array(256).fill(0xff);
  padded.set(image);
  assert.equal(readU32(port.finishPayload, 4), crc32(padded));
  assert.equal(progress.at(-1), 1);
});

test('old bootloader is rejected before App erase', async () => {
  const port = new FakeIapPort({ blVer: 0x0103 });
  const image = appImage();

  await assert.rejects(
    flash(port, image, { release: releaseFor(image) }),
    /Bootloader 过旧/,
  );
  assert.deepEqual(port.commands, [CMD_HELLO]);
});

test('unexpected App layout is rejected before App erase', async () => {
  const port = new FakeIapPort({ appBase: 0x1c00 });
  const image = appImage();

  await assert.rejects(
    flash(port, image, { release: releaseFor(image) }),
    /App 分区不兼容/,
  );
  assert.deepEqual(port.commands, [CMD_HELLO]);
});

test('FINISH rejection is reported as failure instead of false success', async () => {
  const port = new FakeIapPort({ finishStatus: 2 });
  const image = appImage();

  await assert.rejects(
    flash(port, image, { release: releaseFor(image) }),
    (error) => error instanceof IapProtocolError && error.status === 2,
  );
  assert.equal(port.commands.at(-1), CMD_FINISH);
});

test('HELLO product mismatch is rejected before App erase', async () => {
  const port = new FakeIapPort({ productId: 2, boardId: 2 });
  const image = appImage();
  await assert.rejects(flash(port, image, { release: releaseFor(image) }), /Bootloader 产品身份不兼容/);
  assert.deepEqual(port.commands, [CMD_HELLO]);
});

test('embedded Plate manifest is rejected before App erase', async () => {
  const port = new FakeIapPort();
  const image = appImage(209, { productId: 2, boardId: 2 });
  await assert.rejects(flash(port, image, { release: releaseFor(image) }), /固件身份不兼容/);
  assert.deepEqual(port.commands, []);
});

test('probeIapPort confirms a compatible authorized IAP with HELLO', async () => {
  const port = new FakeIapPort();
  const info = await probeIapPort(port, { timeoutMs: 100 });
  assert.equal(info.productId, 1);
  assert.equal(info.boardId, 1);
  assert.deepEqual(port.commands, [CMD_HELLO]);
});

test('probeIapPort marks an incompatible HELLO as IAP instead of App', async () => {
  const port = new FakeIapPort({ productId: 2, boardId: 2 });
  await assert.rejects(
    probeIapPort(port, { timeoutMs: 100 }),
    (error) => error.iapHelloReceived === true && /产品身份不兼容/.test(error.message),
  );
  assert.deepEqual(port.commands, [CMD_HELLO]);
});

test('App IAP entry clears a binary-probe-polluted console line first', async () => {
  const writes = [];
  let opened = false;
  let closed = false;
  const port = {
    writable: new WritableStream({
      write: (bytes) => writes.push(new Uint8Array(bytes)),
    }),
    open: async ({ baudRate }) => {
      assert.equal(baudRate, 115200);
      opened = true;
    },
    close: async () => { closed = true; },
  };

  await enterIap(port);

  assert.equal(opened, true);
  assert.equal(closed, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], new TextEncoder().encode('\r\niap\r\n'));
});

test('waitForAuthorizedIap reuses getPorts permission without requestPort', async () => {
  const port = new FakeIapPort();
  let requestCount = 0;
  const serial = {
    getPorts: async () => [port],
    requestPort: async () => { requestCount += 1; throw new Error('must not prompt'); },
  };
  const detected = await waitForAuthorizedIap({
    serial,
    timeoutMs: 100,
    pollMs: 1,
    probeTimeoutMs: 50,
  });
  assert.equal(detected.port, port);
  assert.equal(detected.info.blVer, 0x0105);
  assert.equal(requestCount, 0);
});

test('waitForAuthorizedIap returns null when no authorized port appears', async () => {
  let requestCount = 0;
  const serial = {
    getPorts: async () => [],
    requestPort: async () => { requestCount += 1; throw new Error('must not prompt'); },
  };
  const detected = await waitForAuthorizedIap({ serial, timeoutMs: 8, pollMs: 1 });
  assert.equal(detected, null);
  assert.equal(requestCount, 0);
});
