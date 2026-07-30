#!/usr/bin/env node

import { webcrypto } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  RELEASE_BOARD,
  RELEASE_MANIFEST_SCHEMA,
  RELEASE_PRODUCT,
  RELEASE_PROFILE,
  parseReleaseManifest,
  sha256Hex,
  validateReleaseDescriptor,
  verifyReleaseBytes,
} from '../firmware.js';
import {
  EXPECTED_APP_BASE,
  EXPECTED_APP_LENGTH,
  EXPECTED_BOARD_ID,
  EXPECTED_PRODUCT_ID,
  EXPECTED_PROFILE_ID,
  EXPECTED_PROG_BLOCK,
  MIN_VERIFIED_FINISH_BL_VERSION,
  parseAppManifest,
  validatePenProductionManifest,
} from '../iap.js';

globalThis.crypto ??= webcrypto;

const VERSION_PATTERN = /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REVISION_PATTERN = /^[0-9a-f]{7,40}$/i;

function usage() {
  return `Usage:
  npm run add-release -- \\
    --image /path/to/firmware.bin \\
    --version 2.9 \\
    --date 2026-07-01 \\
    --source-revision <firmware-git-commit> \\
    [--notes "release notes"] [--dry-run]

The command accepts only SolderingPen / pen_m030 / production App-only images.
It verifies the embedded App manifest, version code, size and SHA-256 before
copying the image and atomically updating firmware/manifest.json.`;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--dry-run') {
      values.dryRun = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    const name = arg.slice(2);
    if (!['image', 'version', 'date', 'source-revision', 'notes'].includes(name)) {
      throw new Error(`未知参数：${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`);
    values[name] = value;
    index += 1;
  }
  for (const required of ['image', 'version', 'date', 'source-revision']) {
    if (!values[required]) throw new Error(`缺少 --${required}`);
  }
  return {
    imagePath: values.image,
    version: values.version,
    date: values.date,
    sourceRevision: values['source-revision'],
    notes: values.notes,
    dryRun: Boolean(values.dryRun),
  };
}

export function firmwareVersionCode(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`版本号必须是 major.minor 或 major.minor.patch：${version}`);
  }
  const parts = version.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  if (parts.some((part) => part > 255)) throw new Error(`版本号分量必须小于 256：${version}`);
  return ((parts[0] << 16) | (parts[1] << 8) | parts[2]) >>> 0;
}

function compareVersionsDescending(left, right) {
  const a = left.version.split('.').map(Number);
  const b = right.version.split('.').map(Number);
  while (a.length < 3) a.push(0);
  while (b.length < 3) b.push(0);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

function validIsoDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

async function validateExistingReleases(firmwareDir, manifest) {
  for (const release of manifest.versions) {
    const bytes = new Uint8Array(await readFile(resolve(firmwareDir, release.file)));
    await verifyReleaseBytes(bytes, release);
  }
}

export async function addFirmwareRelease({
  root = resolve(import.meta.dirname, '..'),
  imagePath,
  version,
  date,
  sourceRevision,
  notes = 'SolderingPen production App-only firmware.',
  dryRun = false,
}) {
  if (!validIsoDate(date)) {
    throw new Error(`发布日期必须是有效的 YYYY-MM-DD：${date}`);
  }
  if (!REVISION_PATTERN.test(sourceRevision)) {
    throw new Error('sourceRevision 必须是 7 到 40 位 Git commit ID');
  }

  const expectedVersionCode = firmwareVersionCode(version);
  const repoRoot = resolve(root);
  const firmwareDir = resolve(repoRoot, 'firmware');
  const manifestPath = resolve(firmwareDir, 'manifest.json');
  const sourcePath = resolve(imagePath);
  const targetFile = `solderingpen-v${version}-iap-v2.bin`;
  const targetPath = resolve(firmwareDir, targetFile);

  const sourceInsideFirmware = relative(firmwareDir, sourcePath);
  if (!sourceInsideFirmware.startsWith('..') && sourceInsideFirmware !== '' &&
      basename(sourcePath) !== targetFile) {
    throw new Error(`firmware/ 内的输入文件必须使用正式文件名 ${targetFile}`);
  }

  const image = new Uint8Array(await readFile(sourcePath));
  const embedded = parseAppManifest(image);
  validatePenProductionManifest(embedded);
  if (embedded.firmwareVersionCode !== expectedVersionCode) {
    throw new Error(
      `版本号与固件内嵌版本不一致：参数=${version} ` +
      `固件=0x${embedded.firmwareVersionCode.toString(16).padStart(8, '0')}`,
    );
  }

  const currentManifest = parseReleaseManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  await validateExistingReleases(firmwareDir, currentManifest);
  const listedFiles = new Set(currentManifest.versions.map((release) => release.file));
  const unlistedBins = (await readdir(firmwareDir))
    .filter((name) => name.endsWith('.bin') && name !== targetFile && !listedFiles.has(name));
  if (unlistedBins.length) {
    throw new Error(`firmware/ 中存在未登记固件：${unlistedBins.join(', ')}`);
  }
  if (currentManifest.versions.some((release) => release.version === version)) {
    throw new Error(`发布清单中已经存在版本 ${version}`);
  }
  if (currentManifest.versions.some((release) => release.file === targetFile)) {
    throw new Error(`发布清单中已经存在文件 ${targetFile}`);
  }

  if (await fileExists(targetPath)) {
    const existing = new Uint8Array(await readFile(targetPath));
    if (!bytesEqual(existing, image)) {
      throw new Error(`目标文件已存在且内容不同：${targetFile}`);
    }
  }

  const sha256 = await sha256Hex(image);
  const release = validateReleaseDescriptor({
    version,
    file: targetFile,
    date,
    notes,
    product: RELEASE_PRODUCT,
    board: RELEASE_BOARD,
    profile: RELEASE_PROFILE,
    productId: EXPECTED_PRODUCT_ID,
    boardId: EXPECTED_BOARD_ID,
    profileId: EXPECTED_PROFILE_ID,
    size: image.length,
    sha256,
    appBase: EXPECTED_APP_BASE,
    appLength: EXPECTED_APP_LENGTH,
    progBlock: EXPECTED_PROG_BLOCK,
    minBootloader: MIN_VERIFIED_FINISH_BL_VERSION,
    sourceRevision,
  });
  await verifyReleaseBytes(image, release);

  const nextManifest = parseReleaseManifest({
    schemaVersion: RELEASE_MANIFEST_SCHEMA,
    versions: [...currentManifest.versions, release].sort(compareVersionsDescending),
  });
  const manifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;

  if (dryRun) return { release, manifest: nextManifest, copied: false, dryRun: true };

  await mkdir(firmwareDir, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const imageTemp = resolve(firmwareDir, `.${targetFile}.${suffix}.tmp`);
  const manifestTemp = resolve(dirname(manifestPath), `.manifest.json.${suffix}.tmp`);
  let copied = false;
  try {
    if (!(await fileExists(targetPath))) {
      await writeFile(imageTemp, image);
      await rename(imageTemp, targetPath);
      copied = true;
    }
    await writeFile(manifestTemp, manifestText, 'utf8');
    await rename(manifestTemp, manifestPath);
  } catch (error) {
    await rm(imageTemp, { force: true });
    await rm(manifestTemp, { force: true });
    if (copied) await rm(targetPath, { force: true });
    throw error;
  }

  return { release, manifest: nextManifest, copied, dryRun: false };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await addFirmwareRelease(options);
  const verb = result.dryRun ? 'validated' : 'added';
  console.log(`${verb}: SolderingOS ${result.release.version}`);
  console.log(`file: firmware/${result.release.file}`);
  console.log(`size: ${result.release.size} B`);
  console.log(`sha256: ${result.release.sha256}`);
  console.log(`catalog order: ${result.manifest.versions.map((item) => item.version).join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`add-firmware-release: FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
