import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { openDetachedTabWindow, type DetachedTabOpenPlacement } from "@/lib/detached/detachedTabs";
import { tabDisplayTitle } from "@/lib/tabs/tabPresentation";
import { useQueryStore } from "@/stores/queryStore";

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * 将主窗口指定页签分离到独立子窗口：prepare（结果写缓存+快照，页签不动）→
 * 子窗口创建/分配成功后 finalize 移除主窗口页签。
 * 返回子窗口 label；页签不存在或窗口创建失败返回 null（页签保留在主窗口，由调用方提示）。
 */
export async function detachTabToWindow(tabId: string, t: Translate, placement?: DetachedTabOpenPlacement): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const queryStore = useQueryStore();
  const tab = queryStore.tabs.find((item) => item.id === tabId);
  if (!tab) return null;
  const snapshot = await queryStore.prepareTabDetachSnapshot(tabId);
  if (!snapshot) return null;
  const label = await openDetachedTabWindow({ tabId, title: tabDisplayTitle(tab, t), snapshot, placement });
  if (!label) return null;
  queryStore.finalizeTabDetach(tabId);
  return label;
}
