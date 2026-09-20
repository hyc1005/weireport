/**
 * 存储层（IndexedDB）
 *
 *  为什么不用 localStorage：每个源只有约 5 MB，而一张地图截图 base64 后就有 2~4 MB，
 *  写爆之后 localStorage 是「抛异常」，早期版本把它吞掉了 → 内容静默丢失。
 *
 *  现在的做法：
 *   · 正文（几十 KB）存 projects 表，图片按内容哈希单独存 assets 表（二进制，不膨胀 33%）
 *   · 每次输入只重写正文，图片只在第一次入库时写一次
 *   · 写入失败会真的抛错，由界面显示「保存失败」，不再静默
 *   · 每次保存前留一份旧版本快照（backups 表，每个工程保留 3 份）可回滚
 *   · 自动 GC：没有任何工程/快照引用的图片会被清掉
 *   · 首次运行把 localStorage 里的老数据搬进来，全部写成功之后才删旧键
 */
import { kv, memoryKV, __setKV, type StoreName, type WriteOp } from "./db";
import { decodeDataUrl, encodeDataUrl, hashString, isDataUrl } from "./base64";
import { defaultStepGlyph, HEAD_GLYPHS } from "./headings";
import { mapBlocks } from "./reportOps";
import { DEFAULT_OPTIONS } from "./template";
import { uid, type Block, type CoverStyle, type HeadGlyph, type Report, type Section, type Step } from "./types";
import { projectProgress } from "./wizard";

export { memoryKV, __setKV };

const PROJECT_STORE: StoreName = "projects";
const ASSET_STORE: StoreName = "assets";
const BACKUP_STORE: StoreName = "backups";
const META_STORE: StoreName = "meta";

const INDEX_KEY = "index";
const ASSET_PREFIX = "asset:";
const MAX_BACKUPS = 3;
const BACKUP_MIN_GAP = 60_000;
const APP_NAME = "lab-report-wizard";
const BUNDLE_VERSION = 2;

/** 老的 localStorage 键（迁移用） */
const LEGACY_INDEX_KEY = "labrw:index:v2";
const LEGACY_PROJECT_PREFIX = "labrw:project:v2:";
const LEGACY_DRAFT_KEY = "lab-report-wizard:draft:v1";

export interface ProjectSummary {
  id: string;
  name: string;
  order: string;
  topic: string;
  coverStyle: CoverStyle;
  createdAt: number;
  updatedAt: number;
  done: number;
  total: number;
  /** 截止日期 YYYY-MM-DD，空串表示没设 */
  due: string;
}

export interface StorageUsage {
  /** IndexedDB 已用字节（含浏览器其它来源，仅本应用可见范围内） */
  usage: number;
  quota: number;
  images: number;
  imageBytes: number;
  projects: number;
  backups: number;
}

export interface BackupInfo {
  id: string;
  projectId: string;
  at: number;
  name: string;
  done: number;
  total: number;
}

interface PersistedProject {
  id: string;
  json: Report;
  assetIds: string[];
  updatedAt: number;
}

interface AssetRecord {
  id: string;
  mime: string;
  bytes: Uint8Array;
}

interface BackupRecord {
  id: string;
  projectId: string;
  at: number;
  json: Report;
  assetIds: string[];
}

interface IndexRecord {
  key: string;
  list: ProjectSummary[];
}

/* ---------------- 反序列化：把任何来路的数据补全成合法 Report ---------------- */

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function normalizeAlign(v: unknown): "left" | "center" | "right" | "justify" {
  return v === "center" || v === "right" || v === "justify" || v === "left" ? v : "left";
}

function normalizeGlyph(v: unknown, fallback: HeadGlyph): HeadGlyph {
  return HEAD_GLYPHS.includes(v as HeadGlyph) ? (v as HeadGlyph) : fallback;
}

function normalizeBlock(raw: unknown): Block | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const id = str(b.id) || uid("b");
  switch (b.kind) {
    case "text":
      return {
        id,
        kind: "text",
        text: str(b.text),
        align: normalizeAlign(b.align),
        indent: b.indent === true ? true : undefined,
      };
    case "code":
      return {
        id,
        kind: "code",
        lang: str(b.lang, "js"),
        code: str(b.code),
        showLang: bool(b.showLang, true),
        boxed: bool(b.boxed, true),
      };
    case "image":
      return {
        id,
        kind: "image",
        dataUrl: str(b.dataUrl),
        caption: str(b.caption),
        align: normalizeAlign(b.align ?? "center"),
        widthPct: num(b.widthPct, 0),
        captionPos: b.captionPos === "none" ? "none" : "below",
        w: num(b.w, 0),
        h: num(b.h, 0),
      };
    case "table": {
      const rows = Array.isArray(b.rows)
        ? (b.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((c) => str(c)) : []))
        : [["", ""]];
      return {
        id,
        kind: "table",
        rows: rows.length ? rows : [["", ""]],
        headerRow: bool(b.headerRow, true),
      };
    }
    default:
      return null;
  }
}

function normalizeStep(raw: unknown): Step {
  const s = (raw ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(s.blocks) ? (s.blocks.map(normalizeBlock).filter(Boolean) as Block[]) : [];
  return { id: str(s.id) || uid("s"), title: str(s.title), blocks };
}

function normalizeSection(raw: unknown): Section {
  const s = (raw ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(s.steps) && s.steps.length ? s.steps.map(normalizeStep) : [normalizeStep({})];
  return {
    id: str(s.id) || uid("sec"),
    title: str(s.title, "新小节"),
    mode: s.mode === "steps" ? "steps" : "plain",
    required: bool(s.required, false),
    steps,
  };
}

export function normalizeReport(raw: unknown): Report {
  const r = (raw ?? {}) as Record<string, unknown>;
  const meta = ((r.meta ?? {}) as Record<string, unknown>) ?? {};
  const cover = ((r.cover ?? {}) as Record<string, unknown>) ?? {};
  const options = ((r.options ?? {}) as Record<string, unknown>) ?? {};
  const now = Date.now();

  const sections = Array.isArray(r.sections) && r.sections.length ? (r.sections as unknown[]).map(normalizeSection) : [];

  // 旧草稿里的「表格式」封面已下线，按正式风渲染（同样是独立封面页 + 学号姓名日期）
  const style: CoverStyle =
    cover.style === "table" || cover.style === "hero" ? "hero" : cover.style === "reference" ? "reference" : "plain";
  const order = str(meta.order, "一");
  const topic = str(meta.topic);

  return {
    id: str(r.id) || uid("proj"),
    name: str(r.name) || `实验${order}${topic ? ` ${topic}` : ""}`,
    createdAt: num(r.createdAt, now),
    updatedAt: num(r.updatedAt, now),
    meta: {
      order,
      topic,
      studentId: str(meta.studentId),
      name: str(meta.name),
      date: str(meta.date),
      due: str(meta.due),
    },
    cover: {
      style,
      title: str(cover.title),
      subtitle: str(cover.subtitle),
      showMeta: bool(cover.showMeta, true),
    },
    options: {
      bodySize: num(options.bodySize, DEFAULT_OPTIONS.bodySize),
      subHeadSize: num(options.subHeadSize, DEFAULT_OPTIONS.subHeadSize),
      stepHeadSize: num(options.stepHeadSize, DEFAULT_OPTIONS.stepHeadSize),
      titleSize: num(options.titleSize, DEFAULT_OPTIONS.titleSize),
      bodyFont: str(options.bodyFont, DEFAULT_OPTIONS.bodyFont),
      headFont: str(options.headFont, DEFAULT_OPTIONS.headFont),
      lineSpacing: num(options.lineSpacing, DEFAULT_OPTIONS.lineSpacing),
      firstLineIndent: bool(options.firstLineIndent, DEFAULT_OPTIONS.firstLineIndent),
      justify: bool(options.justify, DEFAULT_OPTIONS.justify),
      pageNumber: bool(options.pageNumber, DEFAULT_OPTIONS.pageNumber),
      toc: bool(options.toc, DEFAULT_OPTIONS.toc),
      // 老工程没有这三项：封面风格只在这里当一次性的默认值
      stepGlyph: normalizeGlyph(options.stepGlyph, defaultStepGlyph(style)),
      stepRestart: options.stepRestart === "section" ? "section" : "document",
      sectionGlyph: normalizeGlyph(options.sectionGlyph, "none"),
      fileNamePattern: str(options.fileNamePattern, DEFAULT_OPTIONS.fileNamePattern),
    },
    sections,
  };
}

export function parseReportJson(text: string): Report | null {
  try {
    const raw = JSON.parse(text) as unknown;
    // 整套备份也是合法 JSON，但它不是「一个工程」，硬 normalize 会得到一个空壳工程
    if (Array.isArray((raw as { projects?: unknown } | null)?.projects)) return null;
    return normalizeReport(raw);
  } catch {
    return null;
  }
}

export function exportReportJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

/* ---------------- 图片：正文里只留引用，二进制单独存 ---------------- */

let lastBackupAt = new Map<string, number>();
let backupMinGap = BACKUP_MIN_GAP;
/** 块对象 → 内容哈希（块没被改过就不用重算） */
const blockHashes = new WeakMap<object, string>();

function assetIdFor(block: Extract<Block, { kind: "image" }>): string {
  let id = blockHashes.get(block);
  if (!id) {
    id = hashString(block.dataUrl);
    blockHashes.set(block, id);
  }
  return id;
}

/** 测试用：重置模块内的缓存 */
export function __resetStorageCaches(): void {
  lastBackupAt = new Map();
  backupMinGap = BACKUP_MIN_GAP;
}
/** 测试用：把快照最小间隔调小 */
export function __setBackupGap(ms: number): void {
  backupMinGap = ms;
}

function collectImageBlocks(report: Report): Array<Extract<Block, { kind: "image" }>> {
  const out: Array<Extract<Block, { kind: "image" }>> = [];
  report.sections.forEach((s) =>
    s.steps.forEach((st) => st.blocks.forEach((b) => {
      if (b.kind === "image" && b.dataUrl) out.push(b);
    })),
  );
  return out;
}

/**
 * 正文 → 可入库的形态：图片改成 asset:<hash> 引用，二进制写进 assets 表。
 * 先确认二进制真的写得进去，再改正文引用：解不开的图（mime 带参数等）整块保持原样，
 * 否则正文里会留下一个指向不存在记录的引用，图片就永久空白了。
 */
async function packReport(report: Report): Promise<{ json: Report; assetIds: string[] }> {
  const wanted = new Map<string, string>(); // asset id → dataUrl
  for (const b of collectImageBlocks(report)) {
    if (!isDataUrl(b.dataUrl)) continue;
    const id = assetIdFor(b);
    if (!wanted.has(id)) wanted.set(id, b.dataUrl);
  }

  // 「这张图存过没有」以库里的 key 为准，不在模块里养一份缓存：
  // 内存缓存说有、库里其实没有（清了站点数据 / 别的标签页删过），字节就永远不会被补写，图直接空白。
  const existing = new Set(await kv().keys(ASSET_STORE));
  const unwritable = new Set<string>();
  for (const [id, dataUrl] of wanted) {
    if (existing.has(id)) continue;
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) {
      unwritable.add(id);
      continue;
    }
    await kv().put(ASSET_STORE, {
      id,
      mime: decoded.mime,
      bytes: decoded.bytes,
    } satisfies AssetRecord);
    existing.add(id);
  }

  const assetIds: string[] = [];
  const json = mapBlocks(report, (b) => {
    if (b.kind !== "image" || !b.dataUrl || !isDataUrl(b.dataUrl)) return b;
    const id = assetIdFor(b);
    if (unwritable.has(id)) return b;
    assetIds.push(id);
    return { ...b, dataUrl: ASSET_PREFIX + id };
  });

  return { json, assetIds };
}

/** 入库形态 → 正文：把 asset:<hash> 还原成真正的 dataURL */
async function unpackReport(json: Report): Promise<Report> {
  const refs = new Set<string>();
  collectImageBlocks(json).forEach((b) => {
    if (b.dataUrl.startsWith(ASSET_PREFIX)) refs.add(b.dataUrl.slice(ASSET_PREFIX.length));
  });
  if (refs.size === 0) return json;

  const resolved = new Map<string, string>();
  for (const id of refs) {
    const asset = await kv().get<AssetRecord>(ASSET_STORE, id);
    if (!asset) continue;
    resolved.set(id, encodeDataUrl(asset.mime, asset.bytes));
  }

  return mapBlocks(json, (b) => {
    if (b.kind !== "image") return b;
    if (!b.dataUrl.startsWith(ASSET_PREFIX)) return b;
    const real = resolved.get(b.dataUrl.slice(ASSET_PREFIX.length));
    return { ...b, dataUrl: real ?? "" };
  });
}

/* ---------------- 索引 ---------------- */

function summarize(report: Report): ProjectSummary {
  const { done, total } = projectProgress(report);
  return {
    id: report.id,
    name: report.name,
    order: report.meta.order,
    topic: report.meta.topic,
    coverStyle: report.cover.style,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    done,
    total,
    due: report.meta.due,
  };
}

/** 任何来路的数据（正文、快照、老草稿）都能安全地算出索引条目 */
function summaryOf(raw: unknown): ProjectSummary {
  return summarize(normalizeReport(raw));
}

async function readIndexList(): Promise<ProjectSummary[]> {
  const rec = await kv().get<IndexRecord>(META_STORE, INDEX_KEY);
  if (!Array.isArray(rec?.list)) return [];
  // 索引是先存的老数据：老条目没有 due 字段，直接交给上层会炸在 undefined.trim()
  return rec.list.map((s) => ({ ...s, due: str(s.due) }));
}

function indexWriteOp(list: ProjectSummary[]): WriteOp {
  return { store: META_STORE, put: { key: INDEX_KEY, list } satisfies IndexRecord };
}

async function writeIndexList(list: ProjectSummary[]): Promise<void> {
  await kv().write([indexWriteOp(list)]);
}

/** 把当前工程算进索引列表（不落库，和正文一起原子提交） */
async function indexListWith(report: Report): Promise<ProjectSummary[]> {
  const list = (await readIndexList()).filter((s) => s.id !== report.id);
  list.push(summarize(report));
  return list;
}

/* ---------------- 快照 ---------------- */

async function pushBackup(prev: PersistedProject): Promise<void> {
  const last = lastBackupAt.get(prev.id) ?? 0;
  if (Date.now() - last < backupMinGap) return;
  lastBackupAt.set(prev.id, Date.now());

  const all = await kv().getAll<BackupRecord>(BACKUP_STORE);
  const mine = all
    .filter((b) => b.projectId === prev.id)
    .sort((a, b) => b.at - a.at)
    .slice(MAX_BACKUPS - 1); // 加上新这份就超了，旧的当场删掉

  await kv().write([
    {
      store: BACKUP_STORE,
      put: {
        id: `${prev.id}:${Date.now().toString(36)}`,
        projectId: prev.id,
        at: Date.now(),
        json: prev.json,
        assetIds: prev.assetIds ?? [],
      } satisfies BackupRecord,
    },
    ...mine.map((old) => ({ store: BACKUP_STORE, del: old.id }) satisfies WriteOp),
  ]);
}

export async function listBackups(projectId: string): Promise<BackupInfo[]> {
  const all = await kv().getAll<BackupRecord>(BACKUP_STORE);
  return all
    .filter((b) => b.projectId === projectId)
    .sort((a, b) => b.at - a.at)
    .map((b) => {
      const report = normalizeReport(b.json);
      const { done, total } = projectProgress(report);
      return { id: b.id, projectId: b.projectId, at: b.at, name: report.name, done, total };
    });
}

export async function clearBackups(projectId: string): Promise<void> {
  const all = await kv().getAll<BackupRecord>(BACKUP_STORE);
  const mine = all.filter((b) => b.projectId === projectId);
  // 一次事务删干净：分多次删，中途失败就留下「删了一半」的快照列表
  if (mine.length) await kv().write(mine.map((b) => ({ store: BACKUP_STORE, del: b.id }) satisfies WriteOp));
  await gcAssets();
}

export async function restoreBackup(projectId: string, backupId: string): Promise<Report | null> {
  const backup = await kv().get<BackupRecord>(BACKUP_STORE, backupId);
  if (!backup || backup.projectId !== projectId) return null;
  // 快照是先存的老数据：缺字段照样得补全，否则恢复出去直接白屏
  const report = await unpackReport(normalizeReport(backup.json));
  return report;
}

/* ---------------- 垃圾回收：没人引用的图片 ---------------- */

export async function gcAssets(): Promise<number> {
  // 图片仓只取 key：GC 判断的是「有没有人引用」，为此把所有 blob 读进内存是白费
  const [projects, backups, assetIds] = await Promise.all([
    kv().getAll<PersistedProject>(PROJECT_STORE),
    kv().getAll<BackupRecord>(BACKUP_STORE),
    kv().keys(ASSET_STORE),
  ]);
  const referenced = new Set<string>();
  projects.forEach((p) => (p.assetIds ?? []).forEach((id) => referenced.add(id)));
  backups.forEach((b) => (b.assetIds ?? []).forEach((id) => referenced.add(id)));

  const doomed = assetIds.filter((id) => !referenced.has(id));
  if (doomed.length) {
    await kv().write(doomed.map((id) => ({ store: ASSET_STORE, del: id }) satisfies WriteOp));
  }
  return doomed.length;
}

/* ---------------- 对外 API ---------------- */

export async function listProjects(): Promise<ProjectSummary[]> {
  let list = await readIndexList();

  if (list.length === 0) {
    const migrated = await migrateFromLocalStorage();
    if (migrated > 0) list = await readIndexList();
  }

  // 索引比正文少就是索引写砸了（老版本分两次提交会留这种洞）：把缺的补回来，
  // 不能只在索引全空时重建 —— 那样一个条目都没有才救得回来。
  const stored = await kv().getAll<PersistedProject>(PROJECT_STORE);
  const known = new Set(list.map((s) => s.id));
  const missing = stored.filter((p) => !known.has(p.id));
  if (missing.length > 0) {
    // 索引的 key 必须是存储 key，别用正文里那个可能已经损坏的 id
    list = list.concat(missing.map((p) => summaryOf({ ...p.json, id: p.id })));
    await writeIndexList(list);
  }

  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProject(id: string): Promise<Report | null> {
  const rec = await kv().get<PersistedProject>(PROJECT_STORE, id);
  if (!rec) return null;
  return unpackReport(normalizeReport(rec.json));
}

/** 保存；失败会抛错（配额、隐私模式、数据库被占用…），调用方必须处理 */
export async function saveProject(report: Report): Promise<void> {
  const stamped: Report = { ...report, updatedAt: Date.now() };
  const { json, assetIds } = await packReport(stamped);

  const prev = await kv().get<PersistedProject>(PROJECT_STORE, report.id);
  if (prev) await pushBackup(prev);

  // 正文和索引一次提交：分开写的话索引写砸就得到一个「存下了但列表里看不见」的工程
  const persisted: PersistedProject = { id: report.id, json, assetIds, updatedAt: stamped.updatedAt };
  await kv().write([
    { store: PROJECT_STORE, put: persisted },
    indexWriteOp(await indexListWith(stamped)),
  ]);

  void gcAssets().catch(() => {
    /* GC 失败不影响保存本身 */
  });
}

export async function deleteProject(id: string): Promise<void> {
  const backups = await kv().getAll<BackupRecord>(BACKUP_STORE);
  const list = (await readIndexList()).filter((s) => s.id !== id);
  await kv().write([
    { store: PROJECT_STORE, del: id },
    ...backups.filter((b) => b.projectId === id).map((b) => ({ store: BACKUP_STORE, del: b.id }) satisfies WriteOp),
    indexWriteOp(list),
  ]);
  void gcAssets().catch(() => undefined);
}

/** 深拷贝一个工程并换新 id（不落库，调用方决定存不存） */
export function cloneReport(report: Report, name?: string): Report {
  const copy = normalizeReport(JSON.parse(JSON.stringify(report)));
  const now = Date.now();
  copy.id = uid("proj");
  copy.name = name ?? `${report.name} 副本`;
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.sections.forEach((s) => {
    s.id = uid("sec");
    s.steps.forEach((st) => {
      st.id = uid("s");
      st.blocks.forEach((b) => {
        b.id = uid("b");
      });
    });
  });
  return copy;
}

export async function storageUsage(): Promise<StorageUsage> {
  let usage = 0;
  let quota = 0;
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      usage = est.usage ?? 0;
      quota = est.quota ?? 0;
    }
  } catch {
    /* 拿不到就算了 */
  }
  const [assets, projects, backups] = await Promise.all([
    kv().getAll<AssetRecord>(ASSET_STORE),
    kv().getAll<PersistedProject>(PROJECT_STORE),
    kv().getAll<BackupRecord>(BACKUP_STORE),
  ]);
  return {
    usage,
    quota,
    images: assets.length,
    imageBytes: assets.reduce((n, a) => n + (a.bytes?.length ?? 0), 0),
    projects: projects.length,
    backups: backups.length,
  };
}

export async function cleanupUnusedAssets(): Promise<number> {
  return gcAssets();
}

/* ---------------- 整套备份（导出 / 导回） ---------------- */

/**
 * 备份文件里必须带着图片本身。
 * 正文存的是 asset:<hash> 引用，光导出引用等于什么都没导出 —— 换浏览器后那些字节再也找不回来。
 */
export interface BackupBundle {
  app: typeof APP_NAME;
  format: "bundle";
  version: number;
  exportedAt: string;
  /** asset 哈希 → dataURL，正文里的 asset:<hash> 按这个表还原 */
  assets: Record<string, string>;
  projects: Array<{ id: string; updatedAt: number; report: Report }>;
  backups: Array<{ id: string; projectId: string; at: number; report: Report }>;
  index: ProjectSummary[];
}

/** 导出全部工程为一份 JSON（终极备份，含图片） */
export async function exportAllJson(): Promise<string> {
  const [index, projects, backups] = await Promise.all([
    readIndexList(),
    kv().getAll<PersistedProject>(PROJECT_STORE),
    kv().getAll<BackupRecord>(BACKUP_STORE),
  ]);

  const referenced = new Set<string>();
  projects.forEach((p) => (p.assetIds ?? []).forEach((id) => referenced.add(id)));
  backups.forEach((b) => (b.assetIds ?? []).forEach((id) => referenced.add(id)));

  const assets: Record<string, string> = {};
  for (const id of referenced) {
    const asset = await kv().get<AssetRecord>(ASSET_STORE, id);
    if (asset) assets[id] = encodeDataUrl(asset.mime, asset.bytes);
  }

  const bundle: BackupBundle = {
    app: APP_NAME,
    format: "bundle",
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    assets,
    projects: projects.map((p) => ({ id: p.id, updatedAt: p.updatedAt, report: p.json })),
    backups: backups.map((b) => ({ id: b.id, projectId: b.projectId, at: b.at, report: b.json })),
    index,
  };
  return JSON.stringify(bundle, null, 2);
}

/** 认一下这份 JSON 是不是整套备份（不是单工程导出）。老版本的备份没有 format，也认下来。 */
export function parseBackupBundle(text: string): BackupBundle | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || r.app !== APP_NAME) return null;
  if (!Array.isArray(r.projects)) return null;
  return {
    app: APP_NAME,
    format: "bundle",
    version: num(r.version, 1),
    exportedAt: str(r.exportedAt),
    assets: (r.assets && typeof r.assets === "object" ? r.assets : {}) as Record<string, string>,
    projects: (r.projects as Array<Record<string, unknown>>).map((p) => ({
      id: str(p.id),
      updatedAt: num(p.updatedAt, 0),
      report: normalizeReport(p.report ?? p),
    })),
    backups: Array.isArray(r.backups)
      ? (r.backups as Array<Record<string, unknown>>).map((b) => ({
          id: str(b.id),
          projectId: str(b.projectId),
          at: num(b.at, 0),
          report: normalizeReport(b.report ?? b),
        }))
      : [],
    index: Array.isArray(r.index) ? (r.index as ProjectSummary[]) : [],
  };
}

/**
 * 从备份里取出工程：asset 引用还原成图片，缺字节的图位子上留空但文字照旧。
 * 只还原不落库，由调用方决定存不存、覆盖谁。
 */
export function bundleReports(bundle: BackupBundle): Report[] {
  const assets = bundle.assets ?? {};
  return bundle.projects.map((entry) => {
    const report = normalizeReport(entry.report);
    return mapBlocks(report, (b) => {
      if (b.kind !== "image" || !b.dataUrl.startsWith(ASSET_PREFIX)) return b;
      const dataUrl = assets[b.dataUrl.slice(ASSET_PREFIX.length)];
      return { ...b, dataUrl: dataUrl ?? "" };
    });
  });
}

/** 这份备份里引用了但没带字节的图（老版备份文件必然是 0 张以上） */
export function bundleMissingImages(bundle: BackupBundle): number {
  let n = 0;
  for (const entry of bundle.projects) {
    for (const b of collectImageBlocks(normalizeReport(entry.report))) {
      if (b.dataUrl.startsWith(ASSET_PREFIX) && !bundle.assets?.[b.dataUrl.slice(ASSET_PREFIX.length)]) n += 1;
    }
  }
  return n;
}

/**
 * 导入备份 / 单工程 JSON 时落地。库里已经有同 id 的工程就**不覆盖**，另存成一份副本：
 * 备份是拿来救命的，不该把用户眼前正在写的那份盖掉（导入老备份 = 静默回滚）。
 */
export async function importReports(reports: Report[]): Promise<{ imported: Report[]; collided: number }> {
  let collided = 0;
  const imported: Report[] = [];
  for (const r of reports) {
    const hit = await kv().get<PersistedProject>(PROJECT_STORE, r.id);
    const target = hit ? cloneReport(r, `${r.name}（备份导入）`) : r;
    if (hit) collided += 1;
    await saveProject(target);
    imported.push(target);
  }
  return { imported, collided };
}

/* ---------------- 从 localStorage 迁移 ---------------- */

function safeGet(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemove(key: string): void {
  try {
    localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

function legacyKeys(): string[] {
  const keys: string[] = [];
  try {
    if (typeof localStorage === "undefined") return keys;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(LEGACY_PROJECT_PREFIX) || k === LEGACY_INDEX_KEY || k === LEGACY_DRAFT_KEY) keys.push(k);
    }
  } catch {
    /* ignore */
  }
  return keys;
}

/**
 * 把 localStorage 里的老数据搬进 IndexedDB。
 * 只有全部写成功之后才删旧键 —— 搬不动就留着，宁可占着也不能丢。
 */
export async function migrateFromLocalStorage(): Promise<number> {
  const keys = legacyKeys();
  if (keys.length === 0) return 0;

  const reports: Report[] = [];
  for (const key of keys) {
    if (key === LEGACY_INDEX_KEY) continue;
    const raw = safeGet(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const inner = (parsed as { report?: unknown })?.report ?? parsed;
      reports.push(normalizeReport(inner));
    } catch {
      /* 单条坏数据不影响其它 */
    }
  }
  if (reports.length === 0) return 0;

  const list: ProjectSummary[] = [];
  for (const report of reports) {
    const { json, assetIds } = await packReport(report);
    await kv().put(PROJECT_STORE, {
      id: report.id,
      json,
      assetIds,
      updatedAt: report.updatedAt,
    } satisfies PersistedProject);
    list.push(summarize(report));
  }
  await writeIndexList(list);

  // 到这里说明 IDB 已经写成功了，才清理旧键
  for (const key of keys) safeRemove(key);
  return reports.length;
}
