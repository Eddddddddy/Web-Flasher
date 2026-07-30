import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FULL_FLASH_IMAGE_LENGTH,
  parseReleaseManifest,
  sha256Hex,
  verifyReleaseBytes,
} from '../firmware.js';
import {
  APP_MANIFEST_OFFSET,
  APP_MANIFEST_MAGIC,
  APP_MANIFEST_VERSION,
} from '../iap.js';

function validRelease(overrides = {}) {
  return {
    version: '3.0',
    file: 'solderingpen-v3.0.bin',
    date: '2026-07-29',
    notes: 'production',
    product: 'soldering-pen',
    board: 'pen_m030',
    profile: 'production',
    productId: 1,
    boardId: 1,
    profileId: 1,
    size: 4,
    sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
    appBase: 0x1800,
    appLength: 0xe380,
    progBlock: 128,
    minBootloader: 0x0105,
    sourceRevision: '7c3d10a',
    ...overrides,
  };
}

test('release manifest accepts only the current Pen production contract', () => {
  const manifest = parseReleaseManifest({ schemaVersion: 2, versions: [validRelease()] });
  assert.equal(manifest.versions[0].product, 'soldering-pen');
  assert.equal(manifest.versions[0].minBootloader, 0x0105);
});

test('Plate or diagnostic images cannot enter the public Pen release manifest', () => {
  assert.throws(
    () => parseReleaseManifest({ schemaVersion: 2, versions: [validRelease({ product: 'heating-plate' })] }),
    /只接受 SolderingPen/,
  );
  assert.throws(
    () => parseReleaseManifest({ schemaVersion: 2, versions: [validRelease({ profile: 'production-diag' })] }),
    /只接受 SolderingPen/,
  );
});

test('combined and factory images can never enter the public release', async () => {
  for (const file of ['solderingpen-v3.0-combined.bin', 'factory-solderingpen-v3.0.bin']) {
    assert.throws(
      () => parseReleaseManifest({ schemaVersion: 2, versions: [validRelease({ file })] }),
      /禁止发布 combined\/factory 组合镜像/,
    );
  }

  const fullFlash = new Uint8Array(FULL_FLASH_IMAGE_LENGTH);
  await assert.rejects(
    verifyReleaseBytes(fullFlash, validRelease({
      size: fullFlash.length,
      sha256: await sha256Hex(fullFlash),
    })),
    /禁止发布 64 KiB 全片组合镜像/,
  );
});

test('release bytes are checked against both size and SHA-256', async () => {
  const bytes = new Uint8Array(APP_MANIFEST_OFFSET + 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(APP_MANIFEST_OFFSET, APP_MANIFEST_MAGIC, true);
  view.setUint8(APP_MANIFEST_OFFSET + 4, APP_MANIFEST_VERSION);
  view.setUint8(APP_MANIFEST_OFFSET + 5, 1);
  view.setUint8(APP_MANIFEST_OFFSET + 6, 1);
  view.setUint8(APP_MANIFEST_OFFSET + 7, 1);
  view.setUint32(APP_MANIFEST_OFFSET + 8, 0x00030000, true);
  const sha256 = await sha256Hex(bytes);
  const release = validRelease({ size: bytes.length, sha256 });
  assert.equal(await sha256Hex(bytes), release.sha256);
  await verifyReleaseBytes(bytes, release);
  const changed = bytes.slice();
  changed[0] = 1;
  await assert.rejects(verifyReleaseBytes(changed, release), /SHA-256 不匹配/);
  await assert.rejects(verifyReleaseBytes(Uint8Array.of(1, 2), release), /固件大小不匹配/);
});
