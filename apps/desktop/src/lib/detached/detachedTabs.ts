/**
 * 主窗口页签分离为独立子窗口的通用机制。
 *
 * 模型：所有权转移。分离时主窗口把页签快照（serializeOpenTabs 格式，结果数据经
 * IndexedDB 结果缓存共享）写入 localStorage registry 并关闭主窗口页签；子窗口从
 * registry 恢复快照后全权持有该页签（本地执行、本地编辑）。合并（dock）时子窗口
 * 写回最新快照，主窗口恢复页签并关闭子窗口。
 *
 * registry 同时充当崩溃保护：主窗口退出时子窗口随之销毁，registry 中未 dock 的
 * 页签在下次启动时恢复回主窗口。
 *
 * 延迟优化：主窗口空闲时预热一个隐藏 shell 子窗口（完成前端 bundle 加载与 store
 * 初始化），分离时直接分配页签并 show，省掉 webview 冷启动开销。
 */
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { DETACHED_TAB_PARAM, DETACHED_TAB_SHELL_PARAM } from "@/lib/detached/detachedWindowContext";
import { MAIN_WINDOW_LABEL, loadDetachedWindowPlacement, openDetachedWebviewWindow, sendDetachedPanelMessage } from "@/lib/detached/detachedPanel";
import { restoreOpenTabsPayload, serializeOpenTabs, type SavedOpenTab } from "@/lib/app/openTabsPersistence";
import type { QueryTab } from "@/types/database";

// ---------------------------------------------------------------------------
// 页签快照（SavedOpenTab + 分离场景需要往返的额外字段）
// ---------------------------------------------------------------------------

/**
 * 分离页签快照：在 open-tabs 持久化格式之上，附加结构编辑草稿、编辑器视口等
 * open-tabs 持久化不覆盖、但分离/合并往返必须保留的字段。
 */
export type DetachedTabSnapshot = SavedOpenTab & {
  structureDraft?: QueryTab["structureDraft"];
  tableInfoTab?: QueryTab["tableInfoTab"];
  editorViewport?: QueryTab["editorViewport"];
  editorSelection?: QueryTab["editorSelection"];
};

/** 序列化页签为分离快照（结果数据不内嵌，经 resultCacheKey 引用 IndexedDB 结果缓存）。 */
export function serializeDetachedTab(tab: QueryTab): DetachedTabSnapshot {
  const saved = serializeOpenTabs([tab])[0] as DetachedTabSnapshot;
  if (tab.structureDraft) saved.structureDraft = tab.structureDraft;
  if (tab.tableInfoTab) saved.tableInfoTab = tab.tableInfoTab;
  if (tab.editorViewport) saved.editorViewport = { ...tab.editorViewport };
  if (tab.editorSelection) saved.editorSelection = { ...tab.editorSelection };
  // 结果已落缓存的页签（含 data 页签）：强制快照携带 cacheKey + evicted 标记，
  // 使恢复端走缓存读回路径（serializeOpenTabs 仅在 tab.resultEvicted 时携带，
  // 且对 data 页签剔除——分离场景与重启恢复不同，结果需要在窗口间无损转移）。
  if (tab.resultCacheKey) {
    saved.resultCacheKey = tab.resultCacheKey;
    saved.resultEvicted = true;
  }
  return saved;
}

/** 从分离快照重建页签（瞬时执行态由 restoreOpenTabsPayload 剥离；额外字段在此合入）。 */
export function restoreDetachedTabSnapshot(snapshot: DetachedTabSnapshot): QueryTab | null {
  const restored = restoreOpenTabsPayload({ tabs: [snapshot], activeTabId: snapshot.id }).tabs[0];
  if (!restored) return null;
  if (snapshot.structureDraft) restored.structureDraft = snapshot.structureDraft;
  if (snapshot.tableInfoTab) restored.tableInfoTab = snapshot.tableInfoTab;
  if (snapshot.editorViewport) restored.editorViewport = { ...snapshot.editorViewport };
  if (snapshot.editorSelection) restored.editorSelection = { ...snapshot.editorSelection };
  // data 页签的结果缓存引用由 restoreOpenTabsPayload 剔除（重启恢复语义），分离场景补回。
  if (restored.mode === "data" && snapshot.resultCacheKey) {
    restored.resultCacheKey = snapshot.resultCacheKey;
    restored.resultEvicted = true;
    restored.resultCacheState = "disk";
  }
  return restored;
}

// ---------------------------------------------------------------------------
// 子窗口 URL 模式
// ---------------------------------------------------------------------------

/** 子窗口模式：直开指定页签（慢路径）或待命 shell（预热窗口）。 */
export type DetachedTabWindowMode = { kind: "tab"; tabId: string } | { kind: "shell" } | null;

/** 解析当前窗口 URL 中的分离页签参数（仅子窗口有）。 */
export function getDetachedTabModeFromLocation(): DetachedTabWindowMode {
  if (typeof window === "undefined") return null;
  const search = window.location?.search;
  if (!search) return null;
  const params = new URLSearchParams(search);
  const tabId = params.get(DETACHED_TAB_PARAM);
  if (tabId) return { kind: "tab", tabId };
  if (params.has(DETACHED_TAB_SHELL_PARAM)) return { kind: "shell" };
  return null;
}

function detachedTabUrl(tabId: string): string {
  return `index.html?${DETACHED_TAB_PARAM}=${encodeURIComponent(tabId)}`;
}

function detachedTabShellUrl(): string {
  return `index.html?${DETACHED_TAB_SHELL_PARAM}=1`;
}

// ---------------------------------------------------------------------------
// registry（localStorage，跨窗口共享；主窗口 localStorage 为权威）
// ---------------------------------------------------------------------------

const DETACHED_TABS_REGISTRY_KEY = "dbx-detached-tabs-registry";

export interface DetachedTabRegistryEntry {
  /** 页签快照（结果数据经 resultCacheKey 引用 IndexedDB 缓存）。 */
  snapshot: DetachedTabSnapshot;
  /** 当前持有该页签的子窗口 label。 */
  label: string;
  /** 页签显示标题（子窗口标题栏/registry 恢复展示用）。 */
  title: string;
  detachedAt: number;
  updatedAt: number;
}

type DetachedTabsRegistry = Record<string, DetachedTabRegistryEntry>;

function readRegistry(): DetachedTabsRegistry {
  const raw = safeLocalStorageGet(DETACHED_TABS_REGISTRY_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as DetachedTabsRegistry;
  } catch {
    return {};
  }
}

function writeRegistry(registry: DetachedTabsRegistry): void {
  safeLocalStorageSet(DETACHED_TABS_REGISTRY_KEY, JSON.stringify(registry));
}

/** 写入/更新页签的分离快照（子窗口防抖同步最新状态时复用）。 */
export function writeDetachedTabEntry(tabId: string, entry: DetachedTabRegistryEntry): void {
  const registry = readRegistry();
  registry[tabId] = entry;
  writeRegistry(registry);
}

/** 子窗口防抖同步：仅更新快照与 updatedAt，保留 label/title/detachedAt。 */
export function updateDetachedTabSnapshot(tabId: string, snapshot: DetachedTabSnapshot): void {
  const registry = readRegistry();
  const existing = registry[tabId];
  if (!existing) return;
  registry[tabId] = { ...existing, snapshot, updatedAt: Date.now() };
  writeRegistry(registry);
}

export function readDetachedTabEntry(tabId: string): DetachedTabRegistryEntry | null {
  return readRegistry()[tabId] ?? null;
}

export function removeDetachedTabEntry(tabId: string): void {
  const registry = readRegistry();
  if (!(tabId in registry)) return;
  delete registry[tabId];
  writeRegistry(registry);
}

/** 列出全部分离中的页签（主窗口启动时恢复用）。 */
export function listDetachedTabEntries(): DetachedTabRegistryEntry[] {
  return Object.values(readRegistry());
}

export function clearDetachedTabsRegistry(): void {
  safeLocalStorageRemove(DETACHED_TABS_REGISTRY_KEY);
}

// ---------------------------------------------------------------------------
// 子窗口管理（含预热 shell 池）
// ---------------------------------------------------------------------------

/** 每个页签窗口单独记忆位置/尺寸。 */
export function detachedTabPlacementKey(tabId: string): string {
  return `tab-${tabId}`;
}

function sanitizeWindowLabel(tabId: string): string {
  return tabId.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** 慢路径直开窗口 label（与页签绑定，保证单例）。 */
export function detachedTabWindowLabel(tabId: string): string {
  return `panel-tab-${sanitizeWindowLabel(tabId)}`;
}

interface WarmShellState {
  label: string;
  ready: boolean;
}

let warmShell: WarmShellState | null = null;
let warmShellCounter = 0;
let warmShellCreating = false;

/** shell 子窗口广播 ready 时由主窗口调用，标记预热窗口可用。 */
export function markWarmShellReady(label: string): void {
  if (warmShell && warmShell.label === label) warmShell.ready = true;
}

/** 主窗口空闲时确保有一个待命 shell 窗口（隐藏创建，bundle/store 已预热）。 */
export async function ensureWarmDetachedTabShell(): Promise<void> {
  if (!isTauriRuntime() || warmShell || warmShellCreating) return;
  warmShellCreating = true;
  const label = `panel-tab-warm-${++warmShellCounter}`;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      warmShell = { label, ready: false };
      return;
    }
    const { isMacOS } = await import("@/lib/backend/platform");
    const win = new WebviewWindow(label, {
      url: detachedTabShellUrl(),
      title: "DBX",
      width: 1100,
      height: 720,
      minWidth: 480,
      minHeight: 360,
      ...(isMacOS() ? { titleBarStyle: "overlay" as const, hiddenTitle: true } : { decorations: false }),
      visible: false,
    });
    win.once("tauri://error", (error: unknown) => {
      console.error("[detached-tab] create warm shell failed", error);
      if (warmShell?.label === label) warmShell = null;
    });
    win.once("tauri://destroyed", () => {
      if (warmShell?.label === label) warmShell = null;
    });
    warmShell = { label, ready: false };
  } catch (error) {
    console.error("[detached-tab] create warm shell failed", error);
  } finally {
    warmShellCreating = false;
  }
}

export interface DetachedTabOpenPlacement {
  /** 分离瞬间的鼠标屏幕逻辑坐标（拖拽/右键触发位置）。 */
  x?: number;
  y?: number;
}

/**
 * 打开（或聚焦已存在的）页签子窗口。
 * 快照随调用写入 registry（子窗口从 registry 读取），时序保证子窗口读到时快照已就绪；
 * 优先复用预热 shell（秒开），否则新建窗口（慢路径）。
 * 返回窗口 label；失败时清理 registry 并返回 null（调用方负责恢复页签）。
 */
export async function openDetachedTabWindow(options: { tabId: string; title: string; snapshot: DetachedTabSnapshot; placement?: DetachedTabOpenPlacement }): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { tabId, title, snapshot } = options;
  const placement = options.placement ?? {};
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

  // 该页签已在分离中：聚焦既有窗口。
  const existingEntry = readDetachedTabEntry(tabId);
  if (existingEntry) {
    try {
      const existing = await WebviewWindow.getByLabel(existingEntry.label);
      if (existing) {
        if (await existing.isMinimized()) await existing.unminimize();
        await existing.setFocus();
        return existingEntry.label;
      }
    } catch (error) {
      console.error("[detached-tab] focus existing window failed", error);
    }
    // 窗口已不在（异常退出）：清理残留 registry，按新分离处理。
    removeDetachedTabEntry(tabId);
  }

  // 快路径：分配预热 shell（label 先确定，registry 写完再发 assign）。
  if (warmShell?.ready) {
    const shell = warmShell;
    warmShell = null;
    try {
      const win = await WebviewWindow.getByLabel(shell.label);
      if (!win) throw new Error("warm shell window missing");
      writeDetachedTabEntry(tabId, { snapshot, label: shell.label, title, detachedAt: Date.now(), updatedAt: Date.now() });
      // 标题更新失败不阻断分配（标题仅影响任务栏/Alt+Tab 展示）。
      await win.setTitle(`DBX - ${title}`).catch((error) => console.warn("[detached-tab] set title failed", error));
      await sendDetachedPanelMessage(shell.label, { action: "detached-tab-assign", tabId, x: placement.x, y: placement.y });
      // 预热窗口被消耗，后台补充下一个。
      void ensureWarmDetachedTabShell();
      return shell.label;
    } catch (error) {
      console.error("[detached-tab] assign warm shell failed", error);
      removeDetachedTabEntry(tabId);
      void ensureWarmDetachedTabShell();
      return null;
    }
  }

  // 慢路径：新建窗口（位置/尺寸按记忆或鼠标位置创建即定位）。
  const label = detachedTabWindowLabel(tabId);
  try {
    const remembered = placement.x === undefined || placement.y === undefined ? await loadDetachedWindowPlacement(detachedTabPlacementKey(tabId)) : null;
    writeDetachedTabEntry(tabId, { snapshot, label, title, detachedAt: Date.now(), updatedAt: Date.now() });
    const opened = await openDetachedWebviewWindow({
      label,
      title: `DBX - ${title}`,
      url: detachedTabUrl(tabId),
      placementKey: detachedTabPlacementKey(tabId),
      placement: { ...placement, ...(remembered && placement.x === undefined ? { x: remembered.x, y: remembered.y } : {}) },
      defaultWidth: 1100,
      defaultHeight: 720,
      minWidth: 480,
      minHeight: 360,
    });
    if (!opened) {
      removeDetachedTabEntry(tabId);
      return null;
    }
    return label;
  } catch (error) {
    console.error("[detached-tab] create window failed", error);
    removeDetachedTabEntry(tabId);
    return null;
  }
}

/** 关闭指定页签的子窗口（dock 完成后由主窗口调用）。 */
export async function closeDetachedTabWindow(label: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = await WebviewWindow.getByLabel(label);
    await win?.close();
  } catch (error) {
    console.error("[detached-tab] close window failed", error);
  }
}

/** 通知主窗口合并页签（子窗口调用；最新快照需已写入 registry）。 */
export async function requestDockDetachedTab(tabId: string): Promise<void> {
  await sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: "detached-tab-dock", tabId });
}
