import {
  EXPECTED_APP_BASE,
  EXPECTED_APP_LENGTH,
  EXPECTED_PROG_BLOCK,
  MIN_VERIFIED_FINISH_BL_VERSION,
  EXPECTED_PRODUCT_ID,
  EXPECTED_BOARD_ID,
  EXPECTED_PROFILE_ID,
  parseAppManifest,
  validatePenProductionManifest,
} from './iap.js';

export const RELEASE_MANIFEST_SCHEMA = 2;
export const RELEASE_PRODUCT = 'soldering-pen';
export const RELEASE_BOARD = 'pen_m030';
export const RELEASE_PROFILE = 'production';

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`发布清单字段 ${field} 无效`);
  }
  return value.trim();
}

function requireInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`发布清单字段 ${field} 无效`);
  }
  return value;
}

export function validateReleaseDescriptor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('发布清单版本项必须是对象');
  }
  const release = {
    version: requireString(input.version, 'version'),
    file: requireString(input.file, 'file'),
    date: requireString(input.date, 'date'),
    notes: typeof input.notes === 'string' ? input.notes : '',
    product: requireString(input.product, 'product'),
    board: requireString(input.board, 'board'),
    profile: requireString(input.profile, 'profile'),
    productId: requireInteger(input.productId, 'productId'),
    boardId: requireInteger(input.boardId, 'boardId'),
    profileId: requireInteger(input.profileId, 'profileId'),
    size: requireInteger(input.size, 'size'),
    sha256: requireString(input.sha256, 'sha256').toLowerCase(),
    appBase: requireInteger(input.appBase, 'appBase'),
    appLength: requireInteger(input.appLength, 'appLength'),
    progBlock: requireInteger(input.progBlock, 'progBlock'),
    minBootloader: requireInteger(input.minBootloader, 'minBootloader'),
    sourceRevision: requireString(input.sourceRevision, 'sourceRevision'),
  };

  if (!/^[A-Za-z0-9._-]+\.bin$/.test(release.file)) {
    throw new Error(`固件文件名不安全或不是 .bin：${release.file}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release.date)) {
    throw new Error(`发布日期格式无效：${release.date}`);
  }
  if (!/^[0-9a-f]{64}$/.test(release.sha256)) {
    throw new Error('发布清单 SHA-256 必须是 64 位十六进制');
  }
  if (!/^[0-9a-f]{7,40}$/i.test(release.sourceRevision)) {
    throw new Error('sourceRevision 必须是 Git commit ID');
  }
  if (release.product !== RELEASE_PRODUCT || release.board !== RELEASE_BOARD ||
      release.profile !== RELEASE_PROFILE) {
    throw new Error('Web Flasher 只接受 SolderingPen / pen_m030 / production 正式固件');
  }
  if (release.productId !== EXPECTED_PRODUCT_ID ||
      release.boardId !== EXPECTED_BOARD_ID ||
      release.profileId !== EXPECTED_PROFILE_ID) {
    throw new Error('发布清单数值产品/板型/档位身份不符合 Pen production 合约');
  }
  if (release.size <= 0 || release.size > EXPECTED_APP_LENGTH) {
    throw new Error(`发布固件大小超出 App 槽：${release.size}`);
  }
  if (release.appBase !== EXPECTED_APP_BASE || release.appLength !== EXPECTED_APP_LENGTH ||
      release.progBlock !== EXPECTED_PROG_BLOCK) {
    throw new Error('发布清单 App 分区或写入粒度不符合现行布局');
  }
  if (release.minBootloader < MIN_VERIFIED_FINISH_BL_VERSION) {
    throw new Error('发布清单最低 Bootloader 版本不能低于 identity-bound FINISH v0x0105');
  }
  return Object.freeze(release);
}

export function parseReleaseManifest(input) {
  if (!input || input.schemaVersion !== RELEASE_MANIFEST_SCHEMA ||
      !Array.isArray(input.versions) || input.versions.length === 0) {
    throw new Error(`固件清单必须使用 schemaVersion=${RELEASE_MANIFEST_SCHEMA} 且至少包含一个版本`);
  }
  const versions = input.versions.map(validateReleaseDescriptor);
  const files = new Set();
  const versionNames = new Set();
  for (const release of versions) {
    if (files.has(release.file)) throw new Error(`固件文件重复：${release.file}`);
    if (versionNames.has(release.version)) throw new Error(`固件版本重复：${release.version}`);
    files.add(release.file);
    versionNames.add(release.version);
  }
  return Object.freeze({ schemaVersion: RELEASE_MANIFEST_SCHEMA, versions: Object.freeze(versions) });
}

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyReleaseBytes(bytes, release) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== release.size) {
    throw new Error(`固件大小不匹配：实际=${bytes?.length ?? 0}，清单=${release.size}`);
  }
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== release.sha256) {
    throw new Error(`固件 SHA-256 不匹配：实际=${actualSha256}，清单=${release.sha256}`);
  }
  const manifest = parseAppManifest(bytes);
  validatePenProductionManifest(manifest);
  if (manifest.productId !== release.productId ||
      manifest.boardId !== release.boardId ||
      manifest.profileId !== release.profileId) {
    throw new Error('固件内嵌 App manifest 与发布清单身份不一致');
  }
  return actualSha256;
}
