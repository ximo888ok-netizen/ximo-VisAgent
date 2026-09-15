/**
 * composer-dom.ts — contenteditable 输入区 DOM 操作层（chip 工厂 / 光标 / 选区 / 图标回填）
 *
 * 一切「会改 DOM」的能力集中于此，只在四个安全时机被调用：选择应用 / 粘贴 / 删除 / 提交。
 * composition（中文输入）期间绝不触碰这里——事件路由在 useComposerEditor。
 * chip = 文本流中的原子行内节点（contenteditable=false），不再是覆盖层/幽灵文本。
 */
import type { TargetApp } from "@shared/island-contracts";
import {
  CHIP_ATTR,
  CHIP_APP_ATTR,
  CHIP_INVALID_CLASS,
  CHIP_REMOVE_ATTR,
  encodeChipApp,
  findChipNodes,
  serializeEditable,
} from "./composer-lib";
import type { ComposerSnapshot } from "./composer-lib";
import { getCachedIconPng, loadIconPng } from "./AppPicker/iconCache";

/** chip 视觉结构的类名（样式全部在 island.css，本文件不写任何尺寸魔法） */
const CHIP_CLASS = "island-app-chip";
const CHIP_NAME_CLASS = "island-app-chip-name";
const CHIP_REMOVE_CLASS = "island-app-chip-remove";
const CHIP_ICON_CLASS = "island-app-chip-icon";
const CHIP_GLYPH_CLASS = "island-app-chip-glyph";
const ICON_PLATE_CLASS = "island-app-icon-plate island-app-icon-plate--chip";

/**
 * chip 原子节点工厂：图标底衬 + 名称 + × 删除钮，整体 contenteditable=false。
 * 一次退格删整个 chip，不可能出现半个；名称即真实文本节点渲染（非镜像测量）。
 * 失效态描边不在此定型，由 setChipInvalid 随 store 状态同步（单一事实源）。
 */
export function createChipElement(app: TargetApp): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = CHIP_CLASS;
  chip.setAttribute("contenteditable", "false");
  chip.setAttribute(CHIP_ATTR, "1");
  chip.setAttribute(CHIP_APP_ATTR, encodeChipApp(app));
  chip.setAttribute("title", app.name);

  const plate = document.createElement("span");
  plate.className = ICON_PLATE_CLASS;
  const glyph = document.createElement("span");
  glyph.className = CHIP_GLYPH_CLASS;
  glyph.textContent = (app.name.trim().charAt(0) || "?").toUpperCase();
  plate.append(glyph);
  chip.append(plate);

  const name = document.createElement("span");
  name.className = CHIP_NAME_CLASS;
  name.textContent = app.name;
  chip.append(name);

  const remove = document.createElement("span");
  remove.className = CHIP_REMOVE_CLASS;
  remove.setAttribute(CHIP_REMOVE_ATTR, "1");
  remove.setAttribute("aria-hidden", "true");
  remove.textContent = "×";
  chip.append(remove);

  syncChipIcon(chip, app);
  return chip;
}

/** 图标异步回填：缓存命中同步换图（此刻 chip 尚未插入编辑器，不能要求 isConnected）；
 *  未命中留字母兜底，IPC 回来后仅当 chip 仍在场才替换，避免写已移除的节点 */
function syncChipIcon(chip: HTMLSpanElement, app: TargetApp): void {
  const cached = getCachedIconPng(app.exePath);
  if (cached === undefined) {
    void loadIconPng({ exePath: app.exePath, iconRef: app.iconRef }).then((png) => {
      if (png) applyChipIcon(chip, png, true);
    });
    return;
  }
  if (cached) applyChipIcon(chip, cached, false);
}

function applyChipIcon(chip: HTMLSpanElement, pngBase64: string, requireConnected: boolean): void {
  if (requireConnected && !chip.isConnected) return;
  const plate = chip.firstElementChild;
  if (!plate || plate.firstElementChild instanceof HTMLImageElement) return;
  const img = document.createElement("img");
  img.className = CHIP_ICON_CLASS;
  img.src = `data:image/png;base64,${pngBase64}`;
  img.alt = "";
  img.draggable = false;
  plate.replaceChildren(img);
}

/** 移除输入区内全部 chip（解绑路径的 DOM 侧执行者；单实例约束的清理端） */
export function removeChips(root: HTMLElement): void {
  for (const chip of findChipNodes(root.childNodes)) {
    if (chip instanceof HTMLElement) chip.remove();
  }
}

/** 失效态描边同步（主进程 existsSync 预检失败 → 危险色，逻辑同现状） */
export function setChipInvalid(root: HTMLElement, invalid: boolean): void {
  const chip = findChipNodes(root.childNodes)[0];
  if (chip instanceof HTMLElement) chip.classList.toggle(CHIP_INVALID_CLASS, invalid);
}

/** 当前选区是否仍锚在输入区内（picker 抢焦点前保存、回来时校验） */
export function editorSelectionRange(root: HTMLElement): Range | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

export function caretToEnd(root: HTMLElement): void {
  const sel = document.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAfter(node: Node): void {
  const sel = document.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 选择应用 → 光标处插入 chip（旧 chip 一并清除 = 单实例替换），光标落到 chip 之后 */
export function insertChipAtSelection(root: HTMLElement, saved: Range | null, app: TargetApp): void {
  root.focus();
  removeChips(root);
  const chip = createChipElement(app);
  const range = saved && root.contains(saved.commonAncestorContainer) ? saved : null;
  if (range) {
    range.deleteContents();
    range.insertNode(chip);
  } else {
    root.append(chip);
  }
  placeCaretAfter(chip);
}

/** 粘贴注入：text/plain 清洗后以纯文本节点插入，杜绝任何 HTML 进入 DOM */
export function insertPlainTextAtSelection(root: HTMLElement, text: string): void {
  const node = document.createTextNode(text);
  const sel = document.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (range && root.contains(range.commonAncestorContainer)) {
    range.deleteContents();
    range.insertNode(node);
    placeCaretAfter(node);
  } else {
    root.append(node);
    placeCaretAfter(node);
  }
}

/** 提交后复位：清空全部子节点（chip 生命周期移交任务卡） */
export function clearEditor(root: HTMLElement): void {
  root.replaceChildren();
}

/** 读取输入区当前内容（序列化核在 composer-lib，此处仅做 DOM → 结构形状的适配） */
export function readEditor(root: HTMLElement): ComposerSnapshot {
  return serializeEditable(root.childNodes);
}
