import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  addFirmwareRelease,
  firmwareVersionCode,
} from '../scripts/add-firmware-release.mjs';
import {
  APP_MANIFEST_MAGIC,
  APP_MANIFEST_OFFSET,
  APP_MANIFEST_SIZE,
  APP_MANIFEST_VERSION,
} from '../iap.js';

function makeFirmware(version, { productId = 1, boardId = 1, profileId = 1 } = {}) {
  const bytes = new Uint8Array(APP_MANIFEST_OFFSET + APP_MANIFEST_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(APP_MANIFEST_OFFSET, APP_MANIFEST_MAGIC, true);
  view.setUint8(APP_MANIFEST_OFFSET + 4, APP_MANIFEST_VERSION);
  view.setUint8(APP_MANIFEST_OFFSET + 5, productId);
  view.setUint8(APP_MANIFEST_OFFSET + 6, boardId);
  view.setUint8(APP_MANIFEST_OFFSET + 7, profileId);
  view.setUint32(APP_MANIFEST_OFFSET + 8, firmwareVersionCode(version), true);
  return bytes;
}

function releaseFor(version, bytes) {
  return {
    version,
    file: `solderingpen-v${version}-iap-v2.bin`,
    date: '2026-07-29',
    notes: 'fixture',
    product: 'soldering-pen',
    board: 'pen_m030',
    profile: 'production',
    productId: 1,
    boardId: 1,
    profileId: 1,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    appBase: 0x1800,
    appLength: 0xe380,
    progBlock: 128,
    minBootloader: 0x0105,
    sourceRevision: '1234567890abcdef1234567890abcdef12345678',
  };
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'web-flasher-release-'));
  const firmwareDir = resolve(root, 'firmware');
  await mkdir(firmwareDir);
  const current = makeFirmware('3.0');
  const currentRelease = releaseFor('3.0', current);
  await writeFile(resolve(firmwareDir, currentRelease.file), current);
  await writeFile(resolve(firmwareDir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 2,
    versions: [currentRelease],
  }, null, 2)}\n`);
  return { root, firmwareDir };
}

test('historical release import copies, verifies and sorts the catalog', async (t) => {
  const { root, firmwareDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, 'candidate.bin');
  const historical = makeFirmware('2.9');
  await writeFile(source, historical);

  const result = await addFirmwareRelease({
    root,
    imagePath: source,
    version: '2.9',
    date: '2026-07-01',
    sourceRevision: 'abcdef0123456789abcdef0123456789abcdef01',
    notes: 'historical release',
  });

  assert.equal(result.copied, true);
  assert.deepEqual(result.manifest.versions.map((release) => release.version), ['3.0', '2.9']);
  assert.deepEqual(
    new Uint8Array(await readFile(resolve(firmwareDir, 'solderingpen-v2.9-iap-v2.bin'))),
    historical,
  );
  const saved = JSON.parse(await readFile(resolve(firmwareDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(saved.versions.map((release) => release.version), ['3.0', '2.9']);
  assert.match(saved.versions[1].sha256, /^[0-9a-f]{64}$/);
});

test('dry-run validates a release without copying or changing the manifest', async (t) => {
  const { root, firmwareDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, 'candidate.bin');
  await writeFile(source, makeFirmware('2.9'));
  const before = await readFile(resolve(firmwareDir, 'manifest.json'), 'utf8');

  const result = await addFirmwareRelease({
    root,
    imagePath: source,
    version: '2.9',
    date: '2026-07-01',
    sourceRevision: 'abcdef0',
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  await assert.rejects(readFile(resolve(firmwareDir, 'solderingpen-v2.9-iap-v2.bin')), /ENOENT/);
  assert.equal(await readFile(resolve(firmwareDir, 'manifest.json'), 'utf8'), before);
});

test('mismatched visible and embedded versions are rejected without mutation', async (t) => {
  const { root, firmwareDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, 'candidate.bin');
  await writeFile(source, makeFirmware('2.8'));
  const before = await readFile(resolve(firmwareDir, 'manifest.json'), 'utf8');

  await assert.rejects(addFirmwareRelease({
    root,
    imagePath: source,
    version: '2.9',
    date: '2026-07-01',
    sourceRevision: 'abcdef0',
  }), /版本号与固件内嵌版本不一致/);

  assert.equal(await readFile(resolve(firmwareDir, 'manifest.json'), 'utf8'), before);
  await assert.rejects(readFile(resolve(firmwareDir, 'solderingpen-v2.9-iap-v2.bin')), /ENOENT/);
});

test('invalid calendar dates and duplicate versions are rejected', async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, 'candidate.bin');
  await writeFile(source, makeFirmware('3.0'));

  await assert.rejects(addFirmwareRelease({
    root,
    imagePath: source,
    version: '3.0',
    date: '2026-02-31',
    sourceRevision: 'abcdef0',
  }), /有效的 YYYY-MM-DD/);
  await assert.rejects(addFirmwareRelease({
    root,
    imagePath: source,
    version: '3.0',
    date: '2026-07-29',
    sourceRevision: 'abcdef0',
  }), /已经存在版本 3.0/);
});
