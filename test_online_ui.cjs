// Isolated real-browser test: serves plugin assets only, not another ComfyUI.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const server = http.createServer((req, res) => {
    const files = { '/wheel.js': ['web/wheel.js', 'text/javascript'], '/wheel.css': ['web/wheel.css', 'text/css'] };
    if (files[req.url]) { const [file, type] = files[req.url]; res.setHeader('Content-Type', type); res.end(fs.readFileSync(path.join(__dirname, file))); }
    else res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.translationCalls = [];
      Object.defineProperty(window, 'Translator', { configurable: true, value: {
        create: async options => {
          window.translationCalls.push(options);
          return { translate: async source => `中文：${source}`, destroy() {} };
        },
      } });
    });
    let requests = [], mode = 'match', translationMode = 'server', translationRequests = [], brokenCover = false, catalogError = false;
    await page.route('https://image.civitai.com/**', route => route.fulfill({
      contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/MXYAAAAASUVORK5CYII=', 'base64'),
    }));
    await page.route('**/radial-lora/**', async route => {
      const url = route.request().url();
      let data;
      if (url.endsWith('/catalog')) {
        if (catalogError) return route.fulfill({ status: 503, body: 'unavailable' });
        data = 'abcdefghijkl'.split('').map(name => ({ name, title: name, cover_count: name === 'a' ? 1 : 0, size_bytes: 100 }));
      }
      else if (url.includes('/info?')) data = { base_model: 'test', trigger_words: ['local'], metadata: {} };
      else if (url.includes('/thumbnail?')) return route.fulfill(brokenCover ? { status: 422, json: { error: '封面图片损坏' } } : { contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/MXYAAAAASUVORK5CYII=', 'base64') });
      else if (url.endsWith('/translate')) {
        translationRequests.push(route.request().postDataJSON());
        return route.fulfill(translationMode === 'server' ? { json: { text: `中文：${translationRequests.at(-1).text}` } } : { status: 405, body: '旧服务尚未加载翻译路由' });
      }
      else {
        requests.push(route.request().postDataJSON());
        if (mode === 'error') return route.fulfill({ status: 429, json: { error: '请求过于频繁' } });
        if (mode === 'absent') return route.fulfill({ status: 404, body: 'not found' });
        data = mode === 'missing' ? { found: false, message: '未找到公开版本' } : {
          found: true, model_id: 42, model_name: 'Fixture', description: 'Overall model intro', matched_version_id: 7,
          creator: 'Example', url: 'https://mirror.example/models/42?modelVersionId=7', versions: [
            { id: 7, name: 'local version', base_model: 'Anima', trigger_words: ['flat color, no lineart'], description: '<img src=x onerror=alert(1)>', url: 'https://mirror.example/models/42?modelVersionId=7', images: [{ url: 'https://image.civitai.com/one.png', prompt: 'portrait, vivid colors' }, { url: 'https://image.civitai.com/two.png', prompt: '' }] },
            { id: 8, name: 'other version', base_model: 'Other', trigger_words: ['other'], description: 'Other description', url: 'https://mirror.example/models/42?modelVersionId=8', images: [{ url: 'https://image.civitai.com/three.png', prompt: 'alternate' }] },
            { id: 9, name: 'no notes', base_model: 'Other', trigger_words: [], description: '', url: 'https://mirror.example/models/42?modelVersionId=9', images: [] },
          ],
        };
      }
      return route.fulfill({ json: data });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const { openWheel } = await import('/wheel.js');
      window.selection = '[]';
      localStorage.setItem('radial-lora:civitai-token', 'fixture-token');
      window.layouts = {}; window.folder = '*';
      window.openFixtureWheel = () => openWheel({ getValue: () => window.selection, setValue: value => { window.selection = value; },
        getLayout: () => window.layouts, setLayout: value => { window.layouts = value; },
        getFolder: () => window.folder, setFolder: value => { window.folder = value; } });
      await window.openFixtureWheel();
    });
    await page.locator('.rl-online-version').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('radial-lora:civitai-token')), null, 'obsolete download token is removed');
    assert.equal(await page.locator('.rl-footer').count(), 0);
    assert.equal(await page.locator('.rl-status').evaluate(el => getComputedStyle(el).clipPath), 'inset(50%)');
    assert.equal(await page.locator('.rl-dialog h2').innerText(), 'LoRA 轮盘 · LoRA Wheel');
    for (const [count, pages] of [[4, '1 / 3'], [10, '1 / 2'], [6, '1 / 2']]) {
      await page.evaluate(async value => (await import('/wheel.js')).updateAppearance({ sectors: value }), count);
      assert.equal(await page.locator('.rl-slot').count(), count);
      assert.equal(await page.locator('.rl-sector').count(), count);
      assert.equal(await page.locator('.rl-wheel.is-dense').count(), count === 10 ? 1 : 0);
      assert.equal(await page.locator('.rl-page').innerText(), pages);
      const geometry = await page.locator('.rl-sector').evaluateAll(parts => parts.map(part => {
        const image = part.querySelector('image'), clip = part.ownerSVGElement.querySelector(part.querySelector('[clip-path]').getAttribute('clip-path').slice(4, -1)).firstChild;
        const x = +image.getAttribute('x'), y = +image.getAttribute('y'), size = +image.getAttribute('width');
        return { edge: part.querySelector('.rl-edge').getTotalLength(), inside: [[x, y], [x + size, y], [x, y + size + 3], [x + size, y + size + 3]].every(([px, py]) => clip.isPointInFill(new DOMPoint(px, py))) };
      }));
      assert(geometry.every(part => part.inside && Math.abs(part.edge - geometry[0].edge) < .1), `${count} equal sectors must contain covers`);
      const wheelBox = await page.locator('.rl-wheel').evaluate(e => ({ svg: e.getBoundingClientRect().toJSON(), body: e.parentElement.getBoundingClientRect().toJSON() }));
      assert(wheelBox.svg.bottom <= wheelBox.body.bottom + 1, `${count} sectors must fit inside the dialog`);
    }
    assert.equal(await page.locator('.rl-description h4').innerText(), '版本介绍');
    assert.equal(await page.locator('.rl-version-notes').count(), 0);
    assert.equal(await page.locator('.rl-equip').count(), 0);
    assert.equal(await page.getByTitle('复制全部本地触发词', { exact: true }).count(), 0, 'online triggers replace local triggers');
    await page.locator('.rl-sector[data-name="a"]').click();
    assert.equal(await page.locator('.rl-strengths .rl-strength-control').count(), 1);
    assert.equal(await page.getByLabel('CLIP 强度').count(), 0);
    assert.equal(JSON.parse(await page.evaluate(() => window.selection))[0].strength_clip, 1);
    await page.locator('.rl-sector[data-name="a"]').click();
    assert.equal(await page.evaluate(() => window.selection), '[]');
    const dialogSize = await page.locator('.rl-dialog').boundingBox();
    assert.equal(requests.length, 1, 'visible LoRA should be queried once automatically');
    assert.equal(requests[0].refresh, false);
    assert.equal(await page.locator('.rl-online-description img').count(), 0);
    assert.equal(await page.evaluate(() => window.translationCalls.length), 0);
    await page.locator('.rl-description').getByTitle('翻译作者介绍为中文').click();
    await page.getByText('中文：<img src=x onerror=alert(1)>', { exact: true }).waitFor();
    assert.equal(translationRequests.length, 1);
    assert.equal(await page.evaluate(() => window.translationCalls.length), 0, 'server translation must not download browser packs');
    await page.locator('.rl-description').getByText('原文', { exact: true }).click();
    assert.equal(await page.locator('.rl-description .rl-online-description').innerText(), '<img src=x onerror=alert(1)>');
    await page.getByTitle('复制全部Civitai 触发词', { exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'flat color, no lineart');
    assert.match(await page.locator('.rl-gallery-label').innerText(), /本地封面 · 1 \/ 3/);
    await page.getByTitle('下一张封面').click();
    assert.match(await page.locator('.rl-gallery-label').innerText(), /Civitai封面 · 2 \/ 3/);
    await page.waitForFunction(() => { const image = document.querySelector('.rl-preview img'); return image?.complete && image.naturalWidth > 0; });
    await page.getByText('这张官方示例图的提示词').click();
    await page.getByTitle('复制提示词').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'portrait, vivid colors');
    await page.getByLabel('查看 Civitai 版本', { exact: true }).selectOption('8');
    assert.equal(await page.locator('.rl-online-description').innerText(), 'Other description');
    assert.equal(await page.locator('.rl-download').count(), 0);
    assert.equal(await page.getByText('Civitai API ⚙', { exact: true }).count(), 0);
    translationMode = 'fallback';
    await page.locator('.rl-description').getByTitle('翻译作者介绍为中文').click();
    await page.getByText('中文：Other description', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.translationCalls[0].targetLanguage), 'zh');
    assert.match(await page.locator('.rl-gallery-label').innerText(), /本地封面 · 1 \/ 2/);
    assert.equal(await page.evaluate(() => window.selection), '[]');
    assert.equal(await page.locator('.rl-model-title a').getAttribute('href'), 'https://mirror.example/models/42?modelVersionId=8', 'page link must come from the backend URL, not a hardcoded domain');
    await page.getByLabel('查看 Civitai 版本', { exact: true }).selectOption('9');
    assert.equal(await page.locator('.rl-description h4').innerText(), '模型介绍');
    assert.equal(await page.locator('.rl-online-description').innerText(), 'Overall model intro');
    mode = 'missing';
    await page.locator('.rl-sector[data-name="b"]').dispatchEvent('pointerenter');
    await page.getByText('未找到对应模型', { exact: true }).waitFor();
    await page.getByTitle('复制全部本地触发词', { exact: true }).waitFor();
    const missingSize = await page.locator('.rl-dialog').boundingBox();
    assert.equal(missingSize.width, dialogSize.width);
    assert.equal(missingSize.height, dialogSize.height);
    await page.locator('.rl-sector[data-name="a"]').dispatchEvent('pointerenter');
    await page.locator('.rl-online-version').waitFor();
    mode = 'error';
    await page.getByTitle('刷新 Civitai', { exact: true }).click();
    await page.getByText('请求过于频繁', { exact: true }).waitFor();
    assert.equal(requests.at(-1).refresh, true);
    mode = 'missing';
    await page.getByTitle('重试 Civitai', { exact: true }).click();
    await page.getByText('未找到对应模型', { exact: true }).waitFor();
    mode = 'absent';
    await page.getByTitle('刷新 Civitai', { exact: true }).click();
    await page.getByText('查询接口未加载，请重启现有 ComfyUI 后重试', { exact: true }).waitFor();
    await page.getByText('编辑轮盘', { exact: true }).click();
    assert.equal(await page.locator('.rl-clear-mounted').isVisible(), false);
    assert.equal(await page.locator('.rl-library-item').count(), 12);
    assert.equal(await page.locator('.rl-slot-target').count(), 6);
    if (process.env.RL_SCREENSHOT) await page.locator('.rl-dialog').screenshot({ path: process.env.RL_SCREENSHOT });
    await page.locator('.rl-library-item[data-name="h"]').dragTo(page.locator('.rl-slot-target').first());
    assert.equal(await page.evaluate(() => window.layouts['folder:*'][0]), 'h');
    assert.equal(await page.locator('.rl-sector').first().getAttribute('data-name'), 'h');
    await page.getByText('完成编辑', { exact: true }).click();
    assert.equal(await page.locator('.rl-clear-mounted').isVisible(), true);
    await page.getByTitle('关闭 ×', { exact: true }).click();
    await page.evaluate(() => window.openFixtureWheel());
    assert.equal(await page.locator('.rl-sector').first().getAttribute('data-name'), 'h', 'slot position survives reopening');
    await page.getByText('编辑轮盘', { exact: true }).click();
    await page.getByTitle('只清空轮盘扇区，不卸载已搭载的 LoRA').click();
    assert.equal(await page.locator('.rl-empty').count(), 6);
    assert.equal(await page.evaluate(() => window.selection), '[]', 'wheel clearing does not change mounted selection');
    await page.getByText('恢复默认', { exact: true }).click();
    assert.equal(await page.locator('.rl-sector').count(), 6);
    await page.getByTitle('关闭 ×', { exact: true }).click();
    brokenCover = true;
    await page.evaluate(() => window.openFixtureWheel());
    await page.getByText('本地封面加载失败：封面图片损坏', { exact: true }).waitFor();
    await page.locator('.rl-sector[data-name="a"]').click();
    assert.equal(JSON.parse(await page.evaluate(() => window.selection))[0].name, 'a', 'broken cover must not block equipping');
    await page.getByTitle('关闭 ×', { exact: true }).click();
    catalogError = true;
    await page.evaluate(() => window.openFixtureWheel());
    await page.getByText('无法打开轮盘：LoRA 列表请求失败（HTTP 503）', { exact: true }).waitFor();
    assert.equal(await page.locator('.rl-status.is-error').isVisible(), true);
    await page.getByTitle('关闭 ×', { exact: true }).click();
    assert.deepEqual(errors, []);
    console.log('PASS online UI: layout persistence, drag/drop, stable layout, translation, gallery, view-only versions');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
