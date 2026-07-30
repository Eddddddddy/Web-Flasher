import { createHash, webcrypto } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseReleaseManifest, verifyReleaseBytes } from '../firmware.js';

globalThis.crypto ??= webcrypto;

const root = resolve(import.meta.dirname, '..');
const firmwareDir = resolve(root, 'firmware');
const manifestPath = resolve(firmwareDir, 'manifest.json');
const manifest = parseReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
const referenced = new Set();

for (const release of manifest.versions) {
  const bytes = new Uint8Array(await readFile(resolve(firmwareDir, release.file)));
  await verifyReleaseBytes(bytes, release);
  referenced.add(release.file);
  const shortSha = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  console.log(`release ok: ${release.version} ${release.product}/${release.board}/${release.profile} ` +
              `${bytes.length} B sha256=${shortSha}…`);
}

const unlistedBins = (await readdir(firmwareDir))
  .filter((name) => name.endsWith('.bin') && !referenced.has(name));
if (unlistedBins.length) {
  throw new Error(`firmware/ contains unlisted .bin files: ${unlistedBins.join(', ')}`);
}
