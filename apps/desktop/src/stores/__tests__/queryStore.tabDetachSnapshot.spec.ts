import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

function sampleResult(): QueryResult {
  return { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
}

describe("prepareTabDetachSnapshot keeps result cache references", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
  });

  async function setupStoreWithCacheWrite() {
    vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
      return {
        ...actual,
        writeTabResultSnapshot: vi.fn(async () => true),
      };
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const { restoreDetachedTabSnapshot } = await import("@/lib/detached/detachedTabs");
    return { store: useQueryStore(), restoreDetachedTabSnapshot };
  }

  it("carries resultCacheKey for data tabs so the detached window reads data back from cache", async () => {
    const { store, restoreDetachedTabSnapshot } = await setupStoreWithCacheWrite();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = sampleResult();

    const snapshot = await store.prepareTabDetachSnapshot(tabId);
    expect(snapshot).toBeDefined();
    expect(snapshot?.resultCacheKey).toBe(`tab:${tabId}:result`);
    expect(snapshot?.resultEvicted).toBe(true);

    // 子窗口侧恢复：缓存引用必须保留，否则数据变成"需要重新加载"。
    const restored = restoreDetachedTabSnapshot(snapshot!);
    expect(restored?.mode).toBe("data");
    expect(restored?.resultCacheKey).toBe(`tab:${tabId}:result`);
    expect(restored?.resultEvicted).toBe(true);
    expect(restored?.resultCacheState).toBe("disk");
  });

  it("carries resultCacheKey for query tabs with live results", async () => {
    const { store, restoreDetachedTabSnapshot } = await setupStoreWithCacheWrite();
    const tabId = store.createTab("pg-1", "app", "query_1", "query", "public", "select 1");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = sampleResult();
    tab.lastExecutedSql = "select 1";

    const snapshot = await store.prepareTabDetachSnapshot(tabId);
    expect(snapshot?.resultCacheKey).toBe(`tab:${tabId}:result`);
    expect(snapshot?.resultEvicted).toBe(true);

    const restored = restoreDetachedTabSnapshot(snapshot!);
    expect(restored?.resultCacheKey).toBe(`tab:${tabId}:result`);
    expect(restored?.resultEvicted).toBe(true);
    expect(restored?.resultCacheState).toBe("disk");
  });

  it("does not mark tabs without results as evicted", async () => {
    const { store } = await setupStoreWithCacheWrite();
    const tabId = store.createTab("pg-1", "app", "query_1", "query", "public", "select 1");

    const snapshot = await store.prepareTabDetachSnapshot(tabId);
    expect(snapshot?.resultCacheKey).toBeUndefined();
    expect(snapshot?.resultEvicted).toBeUndefined();
  });
});
