import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('default flasher surface exposes one dynamic primary button', () => {
  const buttons = html.match(/<button\b/g) || [];
  assert.equal(buttons.length, 1);
  assert.match(html, /id="upgradeAction"/);
  assert.match(html, /连接设备并开始升级/);
  assert.doesNotMatch(html, /设备若已通过按住中间键上电进入升级模式/);
  assert.doesNotMatch(html, /id="enter"|id="authorizeIap"|id="flash"/);
});

test('advanced firmware controls and logs are collapsed disclosures', () => {
  assert.match(html, /<details id="advanced" class="advanced">/);
  assert.match(html, /<summary>高级选项：其他固件<\/summary>/);
  assert.match(html, /\$\('fwSelectWrap'\)\.hidden = false/);
  assert.doesNotMatch(html, /fwSelectWrap'\)\.hidden = versions\.length < 2/);
  assert.match(html, /<details id="logDetails" class="panel log-details">/);
  assert.match(html, /<summary>查看详细日志<\/summary>/);
});

test('permission fallback reuses the same primary action', () => {
  assert.match(html, /needPermission:[\s\S]*button: '选择升级设备并继续'/);
  assert.match(html, /const expectIap = flowState === 'needPermission'/);
  assert.match(html, /await runUpgrade\(selectedPort, expectIap\)/);
});
