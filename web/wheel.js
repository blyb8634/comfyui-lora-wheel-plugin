const NS = "http://www.w3.org/2000/svg";
const appearance = { transparency: 100, coverMode: "contain", sectors: 6 };
export function updateAppearance(values) {
  Object.assign(appearance, values);
  const alpha = 1 - Math.max(0, Math.min(100, Number(appearance.transparency) || 0)) / 100;
  document.documentElement.style.setProperty("--rl-background-alpha", String(alpha));
  activeDialog?.dispatchEvent(new Event("rl-appearance"));
}
export function strengthControl(title, value, onChange) {
  const group = el("div", "rl-strength-control");
  const caption = el("span", "rl-strength-caption", title);
  const number = el("input", "rl-strength-number");
  number.type = "number"; number.min = "-100"; number.max = "100"; number.step = "0.01";
  number.setAttribute("aria-label", title);
  const range = el("input", "rl-strength-range");
  range.type = "range"; range.step = "0.01";
  range.setAttribute("aria-label", `${title} 滑块`);
  function sync(next) {
    number.value = Number(next).toFixed(2);
    range.min = Math.min(-2, Math.floor(next)); range.max = Math.max(2, Math.ceil(next));
    range.value = next;
  }
  function commit(next) {
    if (!Number.isFinite(next)) return;
    next = Math.round(Math.max(-100, Math.min(100, next)) * 100) / 100;
    sync(next); onChange(next);
  }
  sync(value);
  number.addEventListener("change", () => {
    if (number.value !== "" && number.reportValidity()) commit(Number(number.value));
  });
  range.addEventListener("input", () => { number.value = Number(range.value).toFixed(2); });
  range.addEventListener("change", () => commit(Number(range.value)));
  const down = button("−", () => commit(Number(number.value) - .01), `${title} 减少 0.01`);
  const up = button("+", () => commit(Number(number.value) + .01), `${title} 增加 0.01`);
  const edit = el("div", "rl-strength-edit");
  edit.append(down, number, up);
  group.append(caption, edit, range);
  return group;
}
let activeDialog;
export function loadStyle() {
  if (document.querySelector("link[data-radial-lora]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./wheel.css", import.meta.url).href;
  link.dataset.radialLora = "";
  document.head.append(link);
}
function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function svg(tag, attrs = {}) {
  const item = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, value);
  return item;
}
const point = (radius, angle) => [300 + radius * Math.cos(angle), 300 + radius * Math.sin(angle)];
export function sectorPath(index, count = 6) {
  const start = -Math.PI / 2 + index * Math.PI * 2 / count + 0.018;
  const end = -Math.PI / 2 + (index + 1) * Math.PI * 2 / count - 0.018;
  return `M${point(276, start)} A276,276 0 0 1 ${point(276, end)} L${point(98, end)} A98,98 0 0 0 ${point(98, start)} Z`;
}
function button(text, action, title = text) {
  const item = el("button", "rl-button", text);
  item.type = "button";
  item.title = title;
  item.addEventListener("click", action);
  return item;
}

export function triggerWords(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).flatMap(value => String(value ?? '').split(/[,，]/)).map(word => word.trim()).filter(Boolean))];
}

async function copyText(text, parent) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // HTTP remote sessions may lack Clipboard API; keep a user-gesture fallback.
    const input = el('textarea'); input.value = text;
    input.style.cssText = 'position:fixed;left:0;top:0;opacity:0;width:1px;height:1px';
    parent.append(input); input.select();
    try { if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请选中文字手动复制'); }
    finally { input.remove(); }
  }
}

export async function openWheel({ getValue, setValue, getLayout = () => ({}), setLayout = () => {}, getFolder = () => "*", setFolder = () => {}, fetcher = fetch, title = "LoRA 轮盘 · LoRA Wheel" }) {
  activeDialog?.close();
  loadStyle();
  const controller = new AbortController();
  const dialog = el("dialog", "rl-dialog");
  activeDialog = dialog;
  const previousFocus = document.activeElement;
  const heading = el("header", "rl-header");
  const titleBox = el("div");
  titleBox.append(el("small", "rl-eyebrow", "LOCAL LIBRARY / LORA WHEEL"), el("h2", "", title));
  const folder = el("select", "rl-folder");
  folder.setAttribute("aria-label", "LoRA 子文件夹");
  folder.append(new Option("全部文件夹", "*"));
  const actions = el("div", "rl-header-actions");
  actions.append(folder, button("关闭 ×", () => dialog.close()));
  heading.append(titleBox, actions);
  const toolbar = el("div", "rl-toolbar");
  const search = el("input", "rl-search");
  search.placeholder = "搜索名称 / 文件夹…";
  search.setAttribute("aria-label", "搜索 LoRA");
  const pages = el("span", "rl-page");
  const status = el("div", "rl-status", "正在读取本地 LoRA…");
  status.setAttribute("role", "status");
  const body = el("div", "rl-body");
  const wheel = svg("svg", { viewBox: "0 0 600 610", class: "rl-wheel", "aria-label": "LoRA 径向轮盘" });
  const info = el("aside", "rl-info");
  body.append(wheel, info);
  dialog.append(heading, toolbar, body, status);
  document.body.append(dialog);
  dialog.addEventListener("close", () => {
    controller.abort();
    dialog.remove();
    if (activeDialog === dialog) activeDialog = null;
    previousFocus?.focus();
  }, { once: true });
  dialog.showModal();
  try { localStorage.removeItem('radial-lora:civitai-token'); } catch { /* Storage may be disabled. */ }
  let entries = [], page = 0, current = null, infoToken = 0, editing = false, pendingName = "";
  const coverIndices = new Map(), metadata = new Map(), online = new Map();
  const translations = new Map();
  const galleryIndices = new Map();
  let queryTimer;
  dialog.addEventListener('close', () => clearTimeout(queryTimer));
  async function copy(text) {
    try { await copyText(text, dialog); status.textContent = `已复制：${text}`; }
    catch (error) { status.textContent = `复制失败：${error.message}`; }
  }
  function triggers(values, title = '触发词') {
    const words = triggerWords(values), section = el('div'), heading = el('div', 'rl-trigger-heading');
    const all = button('复制全部', () => copy(words.join(', ')), `复制全部${title}`);
    all.disabled = !words.length;
    heading.append(el('h4', '', title), all);
    const tokens = el('p', 'rl-triggers');
    words.forEach((word, index) => {
      if (index) tokens.append(document.createTextNode(', '));
      const token = button(word, () => copy(word), `复制：${word}`);
      token.classList.add('rl-trigger'); tokens.append(token);
    });
    if (!words.length) tokens.textContent = '未提供触发词（不自动推断或写入提示词）';
    section.append(heading, tokens);
    return section;
  }
  function translatedDescription(source, key, label) {
    const section = el('section', 'rl-description');
    if (source === '暂无介绍') {
      section.append(el('h4', '', label), el('p', 'rl-online-description', source));
      return section;
    }
    const heading = el('div', 'rl-trigger-heading');
    const text = el('p', 'rl-online-description', source);
    const notice = el('small', 'rl-translate-status');
    const translate = button('翻译', async () => {
      const cached = translations.get(key);
      if (cached?.source === source) {
        const showOriginal = translate.textContent === '原文';
        text.textContent = showOriginal ? source : cached.value;
        translate.textContent = showOriginal ? '译文' : '原文';
        return;
      }
      translate.disabled = true;
      translate.textContent = '翻译中…';
      notice.classList.remove('rl-online-error');
      notice.textContent = '正在翻译…';
      try {
        let value;
        const response = await fetcher('/radial-lora/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: source }), signal: controller.signal,
        });
        if (response.ok) value = (await response.json()).text;
        else if ([404, 405, 503].includes(response.status)) {
          if (typeof Translator === 'undefined') throw new Error('服务端未配置翻译，当前浏览器也不支持内置翻译');
          notice.textContent = '浏览器首次翻译可能下载语言包';
          const sourceLanguage = /[ぁ-ヿ]/.test(source) ? 'ja' : /[가-힣]/.test(source) ? 'ko' : 'en';
          const translator = await Translator.create({ sourceLanguage, targetLanguage: 'zh' });
          try { value = await translator.translate(source); }
          finally { translator.destroy?.(); }
        } else {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `翻译失败（HTTP ${response.status}）`);
        }
        if (typeof value !== 'string' || !value) throw new Error('翻译结果为空');
        translations.set(key, { source, value });
        if (text.isConnected) {
          text.textContent = value;
          translate.textContent = '原文';
          notice.textContent = '';
        }
      } catch (error) {
        if (text.isConnected) {
          notice.classList.add('rl-online-error');
          notice.textContent = error.message || '翻译不可用';
          translate.textContent = '重试';
        }
      } finally { translate.disabled = false; }
    }, '翻译作者介绍为中文');
    heading.append(el('h4', '', label), translate);
    section.append(heading, text, notice);
    return section;
  }
  async function queryOnline(item, refresh = false) {
      const state = online.get(item.name) || {};
      if (state.pending) return;
      online.set(item.name, { ...state, pending: true, error: '' });
      try {
        const response = await fetcher('/radial-lora/civitai', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: item.name, refresh }), signal: controller.signal,
        });
        if (response.status === 404) throw new Error('查询接口未加载，请重启现有 ComfyUI 后重试');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        online.set(item.name, { data, version: state.version });
      } catch (error) {
        if (controller.signal.aborted) return;
        online.set(item.name, { ...state, pending: false, error: error.message });
      }
      if (current?.name === item.name && dialog.isConnected) showInfo(item);
  }
  function showOnline(item, target, detail) {
    const state = online.get(item.name) || {};
    if (state.error) target.append(el('p', 'rl-online-error', state.error));
    const data = state.data;
    const version = data?.versions?.find(value => value.id === (state.version || data.matched_version_id)) || data?.versions?.[0];
    const title = el('h3', 'rl-model-title');
    const link = el('a', '', data?.model_name || item.title);
    // The backend supplies the page URL so the configured site stays the single source of truth.
    const modelPage = version?.url || data?.url;
    if (Number.isSafeInteger(data?.model_id) && Number.isSafeInteger(version?.id) && typeof modelPage === 'string' && /^https?:\/\//.test(modelPage)) {
      link.href = modelPage;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.append(el('span', '', ' ↗'));
    }
    title.append(link); target.append(title);
    if (data?.creator) target.append(el('p', 'rl-author', `by ${data.creator}`));
    const stateLine = el('div', 'rl-online-state');
    stateLine.setAttribute('role', 'status');
    if (!state.error) stateLine.append(el('small', '', state.pending ? '查询中…' : data ? 'Civitai' : '待查询'));
    if (data || state.error) {
      const retry = button('↻', () => queryOnline(item, true), state.error ? '重试 Civitai' : '刷新 Civitai');
      retry.disabled = !!state.pending; stateLine.append(retry);
    }
    target.append(stateLine);
    if (!data) return;
    if (!data.found) { target.append(el('p', '', '未找到对应模型')); return; }
    for (const warning of [data.warning, data.cache_warning]) if (warning) target.append(el('p', '', warning));
    const select = el('select', 'rl-online-version');
    select.setAttribute('aria-label', '查看 Civitai 版本');
    for (const version of data.versions) select.append(new Option(`${version.name}${version.id === data.matched_version_id ? '（本地）' : ''}${version.base_model ? ` · ${version.base_model}` : ''}`, version.id));
    select.value = String(version?.id);
    select.addEventListener('change', () => {
      online.set(item.name, { ...online.get(item.name), version: Number(select.value) });
      showInfo(item);
    });
    target.append(el('label', 'rl-section-label', '版本'), select);
    if (version) detail.append(triggers(version.trigger_words, 'Civitai 触发词'),
      translatedDescription(version.description || data.description || '暂无介绍', `${item.name}:${version.id}`, version.description ? '版本介绍' : '模型介绍'));
    return version;
  }
  const chosen = () => {
    const result = JSON.parse(getValue());
    if (!Array.isArray(result)) throw new Error("节点搭载数据不是数组；请检查工作流数据。");
    return result;
  };
  const normalized = name => name.replaceAll("\\", "/");
  const inFolder = item => {
    const path = normalized(item.name), directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return folder.value === "*" || directory === folder.value || (folder.value && directory.startsWith(folder.value + "/"));
  };
  const filtered = () => entries.filter(item => inFolder(item) && item.name.toLowerCase().includes(search.value.toLowerCase()));
  const layoutKey = () => `folder:${folder.value}`;
  const savedSlots = () => {
    const value = getLayout()?.[layoutKey()];
    return Array.isArray(value) ? value.slice(0, 10) : null;
  };
  const defaultSlots = () => entries.filter(inFolder).slice(0, Math.max(4, Math.min(10, Math.round(Number(appearance.sectors) || 6)))).map(item => item.name);
  function saveSlots(slots) {
    setLayout({ ...(getLayout() || {}), [layoutKey()]: slots.slice(0, 10) });
    render();
  }
  function placeInSlot(index, name) {
    if (!entries.some(item => item.name === name && inFolder(item))) return;
    const slots = savedSlots() || defaultSlots();
    const previous = slots.indexOf(name);
    if (previous >= 0) slots[previous] = null;
    slots[index] = name;
    pendingName = "";
    saveSlots(slots);
  }
  function renderLibrary() {
    const oldScroll = info.querySelector('.rl-library')?.scrollTop || 0;
    const library = el('div', 'rl-library');
    library.append(el('h3', '', '拖动 LoRA 到轮盘扇区'), el('p', 'rl-details', '也可先点名称，再点扇区；点已占用扇区可移出。'));
    const slots = savedSlots() || defaultSlots();
    for (const item of filtered()) {
      const position = slots.indexOf(item.name);
      const entry = button(item.title, () => {
        pendingName = item.name;
        for (const button of library.querySelectorAll('.rl-library-item')) {
          button.classList.toggle('is-picked', button.dataset.name === item.name);
          button.setAttribute('aria-pressed', String(button.dataset.name === item.name));
        }
      }, item.name);
      entry.classList.add('rl-library-item');
      entry.dataset.name = item.name;
      entry.draggable = true;
      entry.setAttribute('aria-pressed', String(pendingName === item.name));
      if (pendingName === item.name) entry.classList.add('is-picked');
      if (position >= 0 && position < Math.max(4, Math.min(10, Math.round(Number(appearance.sectors) || 6)))) entry.append(el('small', '', `扇区 ${position + 1}`));
      entry.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', item.name); event.dataTransfer.effectAllowed = 'move'; });
      library.append(entry);
    }
    if (!filtered().length) library.append(el('p', '', '当前文件夹没有匹配的 LoRA。'));
    info.replaceChildren(library);
    library.scrollTop = oldScroll;
  }
  const coverURL = (item) => `/radial-lora/thumbnail?name=${encodeURIComponent(item.name)}&index=${coverIndices.get(item.name) || 0}`;
  // Resolve URLs through ComfyUI's fetch wrapper for subpath deployments as well.
  const imageURLs = new Map();
  async function imageURL(item) {
    const key = coverURL(item);
    if (!imageURLs.has(key)) {
      imageURLs.set(key, (async () => {
        const response = await fetcher(key, { signal: controller.signal });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || (response.status === 404 ? '预览接口未加载，请重启 ComfyUI' : '封面不可用'));
        }
        const blob = await response.blob();
        controller.signal.throwIfAborted();
        return URL.createObjectURL(blob);
      })().catch(error => { imageURLs.delete(key); throw error; }));
    }
    return imageURLs.get(key);
  }
  dialog.addEventListener("close", () => { for (const pending of imageURLs.values()) pending.then(url => URL.revokeObjectURL(url), () => {}); });
  async function setImage(target, item, attribute = "src") {
    if (!item.cover_count) return;
    const key = coverURL(item);
    target.dataset.coverKey = key;
    try {
      const url = await imageURL(item);
      if (target.isConnected && target.dataset.coverKey === key) target.setAttribute(attribute, url);
    } catch (error) {
      if (target.tagName.toLowerCase() === 'img' && target.isConnected && target.dataset.coverKey === key) {
        target.parentElement.classList.remove('is-loading');
        target.replaceWith(el('small', 'rl-cover-error', `本地封面加载失败：${error.message}`));
      }
    }
  }
  function commit(next) {
    setValue(JSON.stringify(next));
    updateState();
  }
  function toggle(item) {
    const items = chosen(), index = items.findIndex(value => value.name === item.name);
    if (index >= 0) items.splice(index, 1);
    else {
      if (items.length >= 32) { status.textContent = "第一版最多搭载 32 个 LoRA。"; return; }
      items.push({ name: item.name, strength_model: 1, strength_clip: 1 });
    }
    commit(items);
    if (current?.name === item.name) updateStrengths(item);
    else showInfo(item);
  }
  function updateStrengths(item) {
    info.querySelector('.rl-strengths')?.remove();
    const selected = chosen().find(value => value.name === item.name);
    if (!selected) return;
    const strengths = el('div', 'rl-strengths');
    strengths.append(strengthControl('MODEL 强度', selected.strength_model ?? 1, value => {
      const next = chosen(), target = next.find(value => value.name === item.name);
      if (target) { target.strength_model = value; commit(next); }
    }));
    info.insertBefore(strengths, info.querySelector('.rl-online-detail'));
  }
  function updateState() {
    const items = chosen();
    for (const part of wheel.querySelectorAll("[data-name]")) {
      const index = items.findIndex(item => item.name === part.dataset.name);
      part.classList.toggle("is-loaded", index >= 0);
      part.setAttribute("aria-pressed", String(index >= 0));
      part.querySelector(".rl-order").textContent = index >= 0 ? `搭载 ${String(index + 1).padStart(2, "0")}` : "";
    }
    const count = wheel.querySelector(".rl-count");
    if (count) count.textContent = String(items.length).padStart(2, "0");
    const missing = items.filter(item => !entries.some(entry => entry.name === item.name));
    status.textContent = missing.length ? `警告：${missing.length} 个已搭载文件已缺失` : '';
  }
  async function showInfo(item) {
    const previousScroll = current?.name === item.name ? info.scrollTop : 0;
    if (current?.name !== item.name) {
      info.classList.add('is-switching');
      setTimeout(() => info.classList.remove('is-switching'), 180);
    }
    current = item;
    const token = ++infoToken;
    clearTimeout(queryTimer);
    if (!online.has(item.name)) queryTimer = setTimeout(() => {
      if (current?.name === item.name && dialog.isConnected) queryOnline(item);
    }, 300);
    for (const part of wheel.querySelectorAll("[data-name]")) part.classList.toggle("is-active", part.dataset.name === item.name);
    info.replaceChildren();
    const preview = el("div", "rl-preview");
    const img = el("img");
    img.alt = item.title;
    const state = online.get(item.name);
    const version = state?.data?.versions?.find(value => value.id === (state.version || state.data.matched_version_id)) || state?.data?.versions?.[0];
    const remote = Array.isArray(version?.images) ? version.images : [];
    const total = item.cover_count + remote.length;
    const galleryKey = `${item.name}:${version?.id || 0}`;
    const label = el('span', 'rl-gallery-label');
    const switcher = el('div', 'rl-cover-switch');
    const caption = el('div', 'rl-gallery-caption');
    const showCover = () => {
      const index = Math.min(galleryIndices.get(galleryKey) || 0, Math.max(0, total - 1));
      galleryIndices.set(galleryKey, index);
      img.removeAttribute('src');
      img.dataset.coverKey = '';
      img.onerror = null;
      preview.replaceChildren(); caption.replaceChildren();
      if (!total) {
        preview.append(el('span', 'rl-placeholder', '◈'), el('small', '', state?.pending ? '正在查找 Civitai 封面…' : '暂无封面'));
      } else {
        preview.append(img);
        if (index < item.cover_count) {
          preview.classList.add('is-loading');
          img.onload = () => preview.classList.remove('is-loading');
          img.onerror = () => {
            preview.classList.remove('is-loading');
            img.replaceWith(el('small', 'rl-cover-error', '本地封面无法解码'));
          };
          coverIndices.set(item.name, index);
          setImage(img, item);
          const segment = [...wheel.querySelectorAll('[data-name]')].find(part => part.dataset.name === item.name);
          if (segment) setImage(segment.querySelector('image'), item, 'href');
        } else {
          preview.classList.remove('is-loading');
          const image = remote[index - item.cover_count];
          img.referrerPolicy = 'no-referrer';
          img.src = image.url;
          img.onerror = () => { caption.textContent = 'Civitai 封面加载失败，可切换其他图片'; };
          if (image.prompt) {
            const prompt = el('details', 'rl-image-prompt');
            prompt.append(el('summary', '', '这张官方示例图的提示词'), el('p', '', image.prompt),
              button('复制提示词', () => copy(image.prompt)));
            if (image.negative_prompt) prompt.append(el('p', '', `反向提示词：${image.negative_prompt}`),
              button('复制反向提示词', () => copy(image.negative_prompt)));
            caption.append(prompt);
          }
        }
      }
      label.textContent = total ? `${index < item.cover_count ? '本地' : 'Civitai'}封面 · ${index + 1} / ${total}` : '暂无封面';
    };
    const switchCover = delta => { if (total > 1) { galleryIndices.set(galleryKey, ((galleryIndices.get(galleryKey) || 0) + delta + total) % total); showCover(); } };
    const previous = button('←', () => switchCover(-1), '上一张封面');
    const nextCover = button('→', () => switchCover(1), '下一张封面');
    previous.disabled = nextCover.disabled = total < 2;
    switcher.append(previous, label, nextCover);
    let startX;
    preview.addEventListener('pointerdown', event => { startX = event.clientX; preview.setPointerCapture(event.pointerId); });
    preview.addEventListener('pointerup', event => { if (startX !== undefined && Math.abs(event.clientX - startX) > 35) switchCover(event.clientX < startX ? 1 : -1); startX = undefined; });
    showCover();
    const identity = el('div', 'rl-identity');
    const onlineDetail = el('section', 'rl-online-detail rl-details');
    showOnline(item, identity, onlineDetail);
    info.append(preview, switcher, caption, identity);
    const localWords = el('div', 'rl-local-triggers rl-details');
    const details = el('details', 'rl-details rl-local-details');
    const localInfo = el('div', '', '读取本地信息…');
    details.append(el('summary', '', '本地文件'), localInfo);
    info.append(onlineDetail, localWords, details);
    updateStrengths(item);
    info.scrollTop = previousScroll;
    try {
      if (!metadata.has(item.name)) {
        const response = await fetcher(`/radial-lora/info?name=${encodeURIComponent(item.name)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        metadata.set(item.name, await response.json());
      }
      if (token !== infoToken || !dialog.isConnected) return;
      const data = metadata.get(item.name);
      localInfo.replaceChildren(el('p', 'rl-filename', item.name), el("p", "", `基础模型：${data.base_model}`),
        el("p", "", `文件大小：${(item.size_bytes / 1024 / 1024).toFixed(1)} MB`));
      if (!triggerWords(version?.trigger_words).length && data.trigger_words?.length) localWords.append(triggers(data.trigger_words, '本地触发词'));
      for (const [key, value] of Object.entries(data.metadata)) localInfo.append(el("p", "rl-meta", `${key}: ${value}`));
    } catch (error) { if (token === infoToken) { localInfo.textContent = `本地信息读取失败：${error.message}`; details.open = true; } }
  }
  function render() {
    const sectors = Math.max(4, Math.min(10, Math.round(Number(appearance.sectors) || 6)));
    const matches = filtered(), total = Math.max(1, Math.ceil(matches.length / sectors));
    const slots = savedSlots();
    const useSlots = !!slots && (editing || !search.value);
    page = Math.min(Math.max(page, 0), total - 1);
    pages.textContent = editing ? '编辑' : useSlots ? '自定义' : `${page + 1} / ${total}`;
    prev.disabled = editing || useSlots || page === 0; next.disabled = editing || useSlots || page === total - 1;
    wheel.classList.toggle('is-dense', sectors >= 8);
    wheel.replaceChildren();
    wheel.append(svg("circle", { cx: 300, cy: 300, r: 287, class: "rl-rim" }));
    wheel.append(svg("circle", { cx: 300, cy: 300, r: 282, class: "rl-rim-detail" }));
    const defs = svg("defs");
    const shade = svg("linearGradient", { id: "rl-shade", x1: "0", y1: "0", x2: "0", y2: "1" });
    shade.append(svg("stop", { offset: "0%", "stop-color": "#071018", "stop-opacity": ".12" }), svg("stop", { offset: "100%", "stop-color": "#071018", "stop-opacity": ".88" }));
    defs.append(shade); wheel.append(defs);
    const visible = useSlots ? Array.from({ length: sectors }, (_, index) => entries.find(item => item.name === slots[index] && inFolder(item)))
      : (editing ? entries.filter(inFolder).slice(0, sectors) : matches.slice(page * sectors, page * sectors + sectors));
    function bindSlot(target, index, item) {
      if (!editing && !item) return;
      const activate = () => {
        if (!editing) { toggle(item); return; }
        if (pendingName) placeInSlot(index, pendingName);
        else if (item) { const next = savedSlots() || defaultSlots(); next[index] = null; saveSlots(next); }
      };
      target.addEventListener('click', activate);
      target.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
        if (editing && (event.key === 'Delete' || event.key === 'Backspace') && item) { event.preventDefault(); const next = savedSlots() || defaultSlots(); next[index] = null; saveSlots(next); }
        if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          const segments = [...wheel.querySelectorAll(editing ? '.rl-slot-target' : '.rl-sector')];
          const delta = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
          segments[(index + delta + segments.length) % segments.length].focus();
        }
      });
      if (editing) {
        target.addEventListener('dragover', event => { event.preventDefault(); target.classList.add('is-drop-target'); });
        target.addEventListener('dragleave', () => target.classList.remove('is-drop-target'));
        target.addEventListener('drop', event => { event.preventDefault(); target.classList.remove('is-drop-target'); placeInSlot(index, event.dataTransfer.getData('text/plain')); });
      }
    }
    for (let index = 0; index < sectors; index++) {
      const path = sectorPath(index, sectors), item = visible[index];
      wheel.append(svg("path", { d: path, class: "rl-slot" }));
      if (!item) {
        if (editing) {
          const empty = svg('g', { class: 'rl-slot-target rl-empty', role: 'button', tabindex: '0', 'aria-label': `空扇区 ${index + 1}，拖入 LoRA` });
          empty.append(svg('path', { d: path, class: 'rl-empty-shape' }));
          const angle = -Math.PI / 2 + (index + .5) * Math.PI * 2 / sectors;
          const [cx, cy] = point(185, angle);
          const plus = svg('text', { x: cx, y: cy + 8, class: 'rl-empty-label' }); plus.textContent = '+';
          empty.append(plus); wheel.append(empty);
          bindSlot(empty, index, null);
        }
        continue;
      }
      const part = svg("g", { class: `rl-sector is-entering${editing ? ' rl-slot-target' : ''}`, "data-name": item.name, role: "button", tabindex: "0", "aria-label": editing ? `扇区 ${index + 1}：${item.title}，点击移出` : item.title });
      part.append(svg('title'));
      part.firstChild.textContent = item.title;
      const top = svg("g", { class: "rl-top" });
      const clip = svg("clipPath", { id: `rl-clip-${index}` }); clip.append(svg("path", { d: path })); defs.append(clip);
      const art = svg("g", { "clip-path": `url(#rl-clip-${index})` });
      const angle = -Math.PI / 2 + (index + 0.5) * Math.PI * 2 / sectors;
      const [cx, cy] = point(185, angle);
      art.append(svg("path", { d: path, fill: ["#3c5559", "#514c62", "#72564a", "#3a4d64", "#55634e", "#634652"][index % 6] }));
      art.append(svg("path", { d: path, fill: "url(#rl-shade)" }));
      const content = svg("g", { class: "rl-content" });
      const coverSize = Math.floor(Math.min(96, (185 * Math.sin(Math.PI / sectors) - 8) * Math.SQRT2));
      const cover = svg("image", { x: cx - coverSize / 2, y: cy - coverSize / 2, width: coverSize, height: coverSize, preserveAspectRatio: "xMidYMid meet" });
      if (appearance.coverMode !== "fill") content.append(cover);
      const monogram = svg("text", { x: cx, y: cy - 16, class: "rl-monogram" });
      monogram.textContent = item.cover_count ? "" : "◈";
      content.append(monogram);
      const name = svg("text", { x: cx, y: cy + coverSize / 2 + 12, class: "rl-name" });
      const text = Array.from(item.title);
      const lineWidth = Math.min(98, coverSize + 8), lineLength = Math.max(8, Math.floor(lineWidth / 6));
      for (let line = 0; line < 2; line++) {
        const span = svg("tspan", { x: cx, dy: line ? 14 : 0 });
        span.textContent = text.slice(line * lineLength, (line + 1) * lineLength).join('') + (line === 1 && text.length > lineLength * 2 ? "…" : "");
        if ([...span.textContent].reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 11 : 6), 0) > lineWidth) {
          span.setAttribute("textLength", String(lineWidth));
          span.setAttribute("lengthAdjust", "spacingAndGlyphs");
        }
        name.append(span);
      }
      const order = svg("text", { x: cx, y: cy - 58, class: "rl-order" });
      content.append(name, order);
      art.append(content, svg("path", { d: path, class: "rl-press" }));
      top.append(art, svg("path", { d: path, class: "rl-edge" })); part.append(top); wheel.append(part);
      if (appearance.coverMode === "fill") {
        // The tight sector bounds minimize cover scaling; only the unavoidable
        // rectangular-image-to-sector crop remains. Keep artwork upright.
        const bounds = part.querySelector('.rl-edge').getBBox();
        for (const [key, value] of Object.entries({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, preserveAspectRatio: "xMidYMid slice" })) cover.setAttribute(key, value);
        art.insertBefore(cover, art.children[1]);
      }
      setImage(cover, item, "href");
      if (!editing) {
        part.addEventListener("pointerenter", () => { if (current?.name !== item.name) showInfo(item); });
        part.addEventListener("focus", () => { if (current?.name !== item.name) showInfo(item); });
      }
      bindSlot(part, index, item);
    }
    wheel.append(svg("circle", { cx: 300, cy: 300, r: 86, class: "rl-hub" }));
    const counter = svg("text", { x: 300, y: 300, class: "rl-count" });
    const caption = svg("text", { x: 300, y: 326, class: "rl-hub-caption" }); caption.textContent = "EQUIPPED";
    wheel.append(counter, caption);
    updateState();
    if (editing) { current = null; ++infoToken; renderLibrary(); }
    else if (visible.some(Boolean)) showInfo(visible.find(item => item?.name === current?.name) || visible.find(Boolean));
    else { current = null; ++infoToken; info.replaceChildren(el("p", "", "没有匹配的 LoRA。")); }
  }
  const prev = button("←", () => { page--; render(); }, "上一页轮盘");
  const next = button("→", () => { page++; render(); }, "下一页轮盘");
  const edit = button('编辑轮盘', () => {
    editing = !editing; pendingName = ''; page = 0;
    clearTimeout(queryTimer);
    dialog.classList.toggle('is-editing', editing);
    edit.textContent = editing ? '完成编辑' : '编辑轮盘';
    search.value = '';
    render();
  });
  const editActions = el('div', 'rl-edit-actions');
  editActions.append(button('一键拆卸轮盘', () => { saveSlots(Array(10).fill(null)); }, '只清空轮盘扇区，不卸载已搭载的 LoRA'),
    button('恢复默认', () => {
      const next = { ...(getLayout() || {}) };
      delete next[layoutKey()]; setLayout(next); render();
    }));
  const clearMounted = button("清空搭载", () => { commit([]); if (current && !editing) showInfo(current); });
  clearMounted.classList.add('rl-clear-mounted');
  toolbar.append(search, prev, pages, next, edit, editActions, clearMounted);
  search.addEventListener("input", () => { page = 0; render(); });
  folder.addEventListener("change", () => { page = 0; pendingName = ''; setFolder(folder.value); render(); });
  dialog.addEventListener("rl-appearance", () => { if (entries.length) render(); });
  try {
    chosen();
    const response = await fetcher("/radial-lora/catalog", { signal: controller.signal });
    if (!response.ok) throw new Error(`LoRA 列表请求失败（HTTP ${response.status}）`);
    entries = await response.json();
    const directories = new Set();
    for (const item of entries) {
      const parts = normalized(item.name).split("/"); parts.pop();
      if (!parts.length) directories.add("");
      for (let index = 1; index <= parts.length; index++) directories.add(parts.slice(0, index).join("/"));
    }
    for (const directory of [...directories].sort()) folder.append(new Option(directory || "根目录", directory));
    if ([...folder.options].some(option => option.value === getFolder())) folder.value = getFolder();
    if (dialog.isConnected) render();
  } catch (error) { if (!controller.signal.aborted) { status.textContent = `无法打开轮盘：${error.message}`; status.classList.add('is-error'); } }
}
