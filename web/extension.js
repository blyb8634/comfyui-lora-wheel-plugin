import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { openWheel, loadStyle, strengthControl, updateAppearance } from "./wheel.js";

loadStyle();
let pathsReady = false;
let pathsInitialized = false;
let pathSave = Promise.resolve();
async function syncPaths(value) {
  const extra_paths = String(value ?? "").split(/[|\n]/).map(path => path.trim()).filter(Boolean);
  const response = await api.fetchApi("/radial-lora/paths", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extra_paths }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
app.registerExtension({
  name: "local.radial-lora",
  async setup() {
    try {
      const response = await api.fetchApi('/radial-lora/paths');
      if (!response.ok) throw new Error('请重启 ComfyUI 以加载路径设置接口');
      const data = await response.json();
      if (app.extensionManager?.setting?.set) await app.extensionManager.setting.set('RadialLoRA.Library.ExtraPaths', data.extra_paths.join(' | '));
      pathsReady = true;
    } catch (error) { console.warn('[Radial LoRA]', error.message); }
    finally { pathsInitialized = true; }
  },
  settings: [
    { id: "RadialLoRA.Library.ExtraPaths", name: "额外 LoRA 目录（多个用 | 分隔）", category: ["LoRA 轮盘", "模型库", "额外 LoRA 目录"], type: "text", defaultValue: "", tooltip: "填写服务器上的绝对路径，如 D:\\LoRA | E:\\Models\\LoRA。留空仍使用 ComfyUI 默认及已配置的路径；只追加，不替换。目录为同一 ComfyUI 服务共享，同名相对路径优先使用原有模型。", onChange: value => {
      if (!pathsReady) {
        if (pathsInitialized) app.extensionManager?.toast?.add?.({ severity: 'warn', summary: '请先重启 ComfyUI', detail: '新路径接口尚未加载；此修改尚未应用到模型库。', life: 8000 });
        return;
      }
      pathSave = pathSave.then(() => syncPaths(value)).catch(async error => {
        app.extensionManager?.toast?.add?.({ severity: 'error', summary: 'LoRA 路径未保存', detail: error.message, life: 8000 });
        const response = await api.fetchApi('/radial-lora/paths');
        if (response.ok && app.extensionManager?.setting?.set) {
          const data = await response.json();
          pathsReady = false;
          pathsInitialized = false;
          try { await app.extensionManager.setting.set('RadialLoRA.Library.ExtraPaths', data.extra_paths.join(' | ')); }
          finally { pathsReady = true; pathsInitialized = true; }
        }
      });
    } },
    { id: "RadialLoRA.Appearance.Transparency", name: "背景透明度", category: ["LoRA 轮盘", "外观", "背景透明度"], type: "slider", defaultValue: 100, attrs: { min: 0, max: 100, step: 1 }, tooltip: "0 为不透明，100 为全透明。只影响轮盘外围背景，不影响封面和文字。", onChange: value => updateAppearance({ transparency: value }) },
    { id: "RadialLoRA.Appearance.CoverMode", name: "饼状图封面", category: ["LoRA 轮盘", "外观", "饼状图封面"], type: "combo", defaultValue: "contain", options: [{ text: "缩小（完整显示）", value: "contain" }, { text: "填充（铺满扇区）", value: "fill" }], onChange: value => updateAppearance({ coverMode: value }) },
    { id: "RadialLoRA.Appearance.Sectors", name: "轮盘扇区数量", category: ["LoRA 轮盘", "外观", "轮盘扇区数量"], type: "slider", defaultValue: 6, attrs: { min: 4, max: 10, step: 1 }, tooltip: "每页均分为 4–10 个扇区，默认 6；数量越多，封面和名称越紧凑。", onChange: value => updateAppearance({ sectors: value }) },
  ],
  loadedGraphNode(node) {
    if (node.comfyClass !== "RadialLoraStack") return;
    if (node.title === "LoRA 轮盘 · Radial Stack") node.title = "LoRA 轮盘 · LoRA Wheel";
    const widget = node.widgets?.find(w => w.name === "selection");
    try {
      const minHeight = 130 + JSON.parse(widget.value).length * 64;
      if (node.size && typeof node.setSize === 'function' && (node.size[0] < 300 || node.size[1] < minHeight)) node.setSize([Math.max(node.size[0], 300), Math.max(node.size[1], minHeight)]);
    } catch { /* Preserve malformed workflows for inspection. */ }
  },
  getCustomWidgets() {
    return {
      RADIAL_LORA_SELECTION(node, name, spec) {
        let value = spec[1]?.default ?? "[]";
        if (typeof node.addDOMWidget !== 'function') {
          // Older frontends can still serialize and run the workflow without the DOM widget.
          const widget = node.addWidget?.('text', name, value, () => {}, { serialize: true });
          return { widget, minWidth: 300, minHeight: 80 };
        }
        const button = document.createElement("button");
        button.className = "rl-launch";
        const container = document.createElement("div");
        container.className = "rl-node";
        const rows = document.createElement("div");
        rows.className = "rl-node-rows";
        container.append(button, rows);
        let rowCount = 0;
        function commit(next) {
          node.graph?.beforeChange();
          widget.value = next;
          node.graph?.afterChange();
          node.setDirtyCanvas(true, true);
        }
        function saveProperty(key, value) {
          node.graph?.beforeChange();
          node.properties ??= {};
          node.properties[key] = value;
          node.graph?.afterChange();
          node.setDirtyCanvas(true, true);
        }
        function label() {
          rows.replaceChildren();
          try {
            const selected = JSON.parse(value);
            rowCount = selected.length;
            button.textContent = `◉ 打开 LoRA 轮盘 · 已搭载 ${rowCount}`;
            if (!rowCount) {
              const empty = document.createElement("div");
              empty.className = "rl-node-empty";
              empty.textContent = "尚未搭载 · MODEL / CLIP 原样通过";
              rows.append(empty);
            }
            for (const item of selected) {
              const row = document.createElement("div");
              row.className = "rl-node-row";
              const name = document.createElement("div");
              name.className = "rl-node-name";
              name.textContent = item.name.replaceAll("\\", "/").split("/").pop().replace(/\.[^.]+$/, "");
              name.title = item.name;
              const header = document.createElement("div");
              header.className = "rl-node-row-header";
              const remove = document.createElement("button");
              remove.className = "rl-remove"; remove.textContent = "×"; remove.type = "button";
              remove.title = `卸载 ${item.name}`; remove.setAttribute("aria-label", remove.title);
              remove.addEventListener("click", () => commit(JSON.stringify(JSON.parse(value).filter(entry => entry.name !== item.name))));
              header.append(name, remove); row.append(header);
              row.append(strengthControl("MODEL", item.strength_model ?? 1, strength => {
                const next = JSON.parse(value), target = next.find(entry => entry.name === item.name);
                if (target) { target.strength_model = strength; commit(JSON.stringify(next)); }
              }));
              rows.append(row);
            }
          }
          catch { button.textContent = "◉ 打开 LoRA 轮盘 · 数据需要修复"; }
        }
        const widget = node.addDOMWidget(name, "RADIAL_LORA_SELECTION", container, {
          getValue: () => value,
          setValue: (next) => {
            if (next === value) return;
            const oldCount = rowCount;
            value = next; label();
            const minHeight = 130 + rowCount * 64;
            const oldMinHeight = 130 + oldCount * 64;
            if (node.size[1] < minHeight || (rowCount < oldCount && node.size[1] <= oldMinHeight + 1)) node.setSize([node.size[0], minHeight]);
          },
          margin: 16,
          getMinHeight: () => 64 + rowCount * 64,
          getHeight: () => 64 + rowCount * 64,
          serialize: true,
        });
        button.addEventListener("click", async () => { await pathSave; return openWheel({
          getValue: () => widget.value,
          setValue: commit,
          getLayout: () => node.properties?.radialLoraLayouts || {},
          setLayout: value => saveProperty('radialLoraLayouts', value),
          getFolder: () => node.properties?.radialLoraFolder || '*',
          setFolder: value => saveProperty('radialLoraFolder', value),
          fetcher: (url, options) => api.fetchApi(url, options),
          title: node.title,
        }); });
        label();
        return { widget, minWidth: 300, minHeight: 130 };
      },
    };
  },
});
