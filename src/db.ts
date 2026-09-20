/**
 * 极简 IndexedDB 封装
 *   · 只用到 get / getAll / put / del / clear 五个动作，外加 write（多个对象store 一次提交）
 *   · 抛出的错误是「真的失败了」，调用方必须处理（不再静默吞掉）
 *   · 通过 __setKV 可以注入内存实现，方便在 Node 里做离线测试
 */

export const STORES = ["projects", "assets", "backups", "meta"] as const;
export type StoreName = (typeof STORES)[number];

/** 一次原子写入里的一个动作 */
export type WriteOp = { store: StoreName; put: unknown } | { store: StoreName; del: string };

export interface KV {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: StoreName): Promise<T[]>;
  /** 只取 key，不搬字节 —— 保存时想知道「这张图在库里有没有」，但不能为此把所有图片读一遍 */
  keys(store: StoreName): Promise<string[]>;
  put(store: StoreName, value: unknown): Promise<void>;
  del(store: StoreName, key: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
  /**
   * 多个对象仓库放进同一个事务：要么全成，要么全不算。
   * 「正文写好了、索引写砸了」会让工程从列表里消失，分开提交挡不住。
   */
  write(ops: WriteOp[]): Promise<void>;
}

const DB_NAME = "lab-report-wizard";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("这个浏览器不支持 IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: store === "meta" ? "key" : "id" });
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("打不开本地数据库"));
    req.onblocked = () => reject(new Error("本地数据库被其它标签页占用，请关掉其它页面后重试"));
  });
  return dbPromise;
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(store, mode);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        const req = fn(tx.objectStore(store));
        let result: T;
        req.onsuccess = () => {
          result = req.result as T;
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? new Error("本地数据库写入失败"));
        tx.onabort = () => reject(tx.error ?? new Error("本地数据库写入被中止"));
      }),
  );
}

const idbKV: KV = {
  get: <T>(store: StoreName, key: string) => run<T | undefined>(store, "readonly", (s) => s.get(key)),
  getAll: <T>(store: StoreName) => run<T[]>(store, "readonly", (s) => s.getAll()),
  keys: (store) =>
    run<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys()).then((ks) => ks.map((k) => String(k))),
  put: (store, value) => run<void>(store, "readwrite", (s) => s.put(value)),
  del: (store, key) => run<void>(store, "readwrite", (s) => s.delete(key)),
  clear: (store) => run<void>(store, "readwrite", (s) => s.clear()),
  write: (ops) => {
    if (ops.length === 0) return Promise.resolve();
    const stores = Array.from(new Set(ops.map((o) => o.store)));
    return openDb().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          let tx: IDBTransaction;
          try {
            tx = db.transaction(stores, "readwrite");
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          for (const op of ops) {
            const s = tx.objectStore(op.store);
            if ("put" in op) s.put(op.put);
            else s.delete(op.del);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("本地数据库写入失败"));
          tx.onabort = () => reject(tx.error ?? new Error("本地数据库写入被中止"));
        }),
    );
  },
};

let current: KV = idbKV;

export function kv(): KV {
  return current;
}

/** 测试用：换成内存实现 */
export function __setKV(next: KV | null): void {
  current = next ?? idbKV;
}

/* ---------------- 内存实现（离线测试 / 极端降级用） ---------------- */

export function memoryKV(): KV {
  const data: Record<string, Map<string, unknown>> = {
    projects: new Map(),
    assets: new Map(),
    backups: new Map(),
    meta: new Map(),
  };
  const keyOf = (store: StoreName, value: unknown): string => {
    const v = value as Record<string, unknown>;
    return String(store === "meta" ? v.key : v.id);
  };
  return {
    async get<T>(store: StoreName, key: string) {
      return data[store].get(key) as T | undefined;
    },
    async getAll<T>(store: StoreName) {
      return Array.from(data[store].values()) as T[];
    },
    async keys(store: StoreName) {
      return Array.from(data[store].keys());
    },
    async put(store: StoreName, value: unknown) {
      data[store].set(keyOf(store, value), value);
    },
    async del(store: StoreName, key: string) {
      data[store].delete(key);
    },
    async clear(store: StoreName) {
      data[store].clear();
    },
    async write(ops: WriteOp[]) {
      for (const op of ops) {
        if ("put" in op) data[op.store].set(keyOf(op.store, op.put), op.put);
        else data[op.store].delete(op.del);
      }
    },
  };
}
