import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockCard, type BlockApi } from "./components/BlockCard";
import { CoverPanel, CoverPreview } from "./components/CoverPanel";
import { Home } from "./components/Home";
import { Outline } from "./components/Outline";
import { SettingsModal } from "./components/SettingsModal";
import { WizardBar } from "./components/WizardBar";
import { PrintDocument } from "./components/PrintDocument";
import { SectionHeading, StepHeading } from "./components/PaperHeadings";
import type { SeqLine } from "./numbering";
import {
  addBlock,
  addSection,
  addStep,
  afterBlock,
  insertBlock,
  insertBlockAt,
  moveBlock,
  moveSection,
  moveStep,
  removeBlock,
  removeSection,
  removeStep,
  renameProject,
  updateBlock,
  updateCover,
  updateMeta,
  updateOptions,
  updateSectionTitle,
  updateStepTitle,
} from "./reportOps";
import { IMAGE_WARN_BYTES, captureOnce, compressImage, formatBytes } from "./capture";
import {
  imageFromClipboardEvent,
  readClipboardImage,
  readClipboardText,
  textFromClipboardEvent,
} from "./clipboard";
import { deadlineLabel, deadlineTone, flattenPages, planDeadline, projectProgress } from "./wizard";
import { computeHeadings, type Headings } from "./headings";
import {
  bundleMissingImages,
  bundleReports,
  cloneReport,
  cleanupUnusedAssets,
  clearBackups,
  deleteProject,
  exportAllJson,
  exportReportJson,
  importReports,
  listBackups,
  listProjects,
  loadProject,
  parseBackupBundle,
  parseReportJson,
  restoreBackup,
  saveProject,
  storageUsage,
  type BackupInfo,
  type ProjectSummary,
  type StorageUsage,
} from "./storage";
import { createReport, createReferenceReport, DEFAULT_OPTIONS, skeletonFrom } from "./template";
import { downloadJson, downloadMarkdown, downloadReport } from "./export";
import { reportFileName } from "./markdown";
import { imageBlock, textBlock, type Block, type BlockKind, type Report } from "./types";
import { parseDocx, type ImportParse, type ItemLevel } from "./docx/parse";
import { buildReportFromItems, makeImagePreparer } from "./templateImport";
import { ImportPreview } from "./components/ImportPreview";
import ExportModal from "./components/ExportModal";
import "./styles.css";
import "./studio.css";

type Busy = null | "capture" | "clipboard" | "export" | "import";

interface SaveState {
  status: "idle" | "saving" | "saved" | "error";
  at?: number;
  message?: string;
}

function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [report, setReportState] = useState<Report | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [resumeId, setResumeId] = useState<string | null>(() => {
    try { return localStorage.getItem("lab-report-wizard:last-project"); } catch { return null; }
  });
  const [printMode, setPrintMode] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  /** Word 导入：解析结果先停在预览里，确认之后才落库 */
  const [importDraft, setImportDraft] = useState<{ fileName: string; parsed: ImportParse } | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  /** 导出 Word 前的确认弹窗（每次都弹；勾选只影响这次导出） */
  const [exportOpen, setExportOpen] = useState(false);
  const [autoCaption, setAutoCaption] = useState(false);

  const pages = useMemo(() => (report ? flattenPages(report) : []), [report]);
  const safeIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const page = pages[safeIndex];

  const pageRef = useRef(page);
  pageRef.current = page;
  const reportRef = useRef(report);
  reportRef.current = report;

  /* ================= 撤销 / 重做 ================= */

  const undoRef = useRef<Report[]>([]);
  const redoRef = useRef<Report[]>([]);
  const lastPushRef = useRef<{ key: string; at: number } | null>(null);

  function clearHistory() {
    undoRef.current = [];
    redoRef.current = [];
    lastPushRef.current = null;
  }

  /**
   * 与 useState setter 同签名的受追踪版本：内容改动先进撤销栈。
   * coalesceKey —— 同一个输入框 1.5 秒内的连续打字只算一步，撤销才打得断。
   */
  function setReport(
    updater: Report | null | ((r: Report | null) => Report | null),
    coalesceKey?: string,
  ) {
    const prev = reportRef.current;
    if (prev && typeof updater === "function") {
      const now = Date.now();
      const last = lastPushRef.current;
      const merged = !!coalesceKey && last !== null && last.key === coalesceKey && now - last.at < 1500;
      if (!merged) {
        undoRef.current.push(prev);
        if (undoRef.current.length > 80) undoRef.current.shift();
        redoRef.current = [];
      }
      lastPushRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    }
    setReportState(updater);
  }

  function stepHistory(dir: "undo" | "redo"): boolean {
    const from = dir === "undo" ? undoRef.current : redoRef.current;
    const to = dir === "undo" ? redoRef.current : undoRef.current;
    const target = from.pop();
    const cur = reportRef.current;
    if (!target || !cur) return false;
    to.push(cur);
    if (to.length > 80) to.shift();
    lastPushRef.current = null;
    setReportState(target);
    return true;
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y")) {
        // 文档级撤销：接管浏览器的输入框原生 undo，避免两套历史互相打架
        e.preventDefault();
        const dir = (e.key === "y" || e.key === "Y") !== e.shiftKey ? "redo" : "undo";
        stepHistory(dir);
        return;
      }
      if (settingsOpen || importDraft || exportOpen) return; // 弹窗开着时不抢键
      if (!selectedBlockId || !page || page.kind !== "content" || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+C / Ctrl+P 这些是浏览器的，别抢
      const kind = ({ p: "image", c: "code", t: "text" } as Record<string, BlockKind>)[e.key.toLowerCase()];
      if (!kind) return;
      e.preventDefault();
      setReport((r) => {
        if (!r) return r;
        const index = afterBlock(page.step.blocks, selectedBlockId);
        const out =
          index === undefined
            ? addBlock(r, page.sectionId, page.stepId, kind)
            : insertBlockAt(r, page.sectionId, page.stepId, index, kind);
        setSelectedBlockId(out.blockId);
        return out.report;
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedBlockId, page, settingsOpen, exportOpen, importDraft]);

  /* ================= 保存引擎 ================= */

  const dirtySeqRef = useRef(0);
  const savedSeqRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const debounceRef = useRef<number | null>(null);
  const maxWaitRef = useRef<number | null>(null);
  const lastSavedAtRef = useRef(0);
  const saveStateRef = useRef<SaveState>({ status: "idle" });
  /** 刚载入的工程不需要立刻回写一次 */
  const skipSaveForRef = useRef<Report | null>(null);

  /** 页面内容变了但还没落库 */
  const isDirty = () => savedSeqRef.current !== dirtySeqRef.current;
  const markDirty = () => {
    dirtySeqRef.current += 1;
  };

  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  const clearMaxWait = () => {
    if (maxWaitRef.current !== null) {
      window.clearTimeout(maxWaitRef.current);
      maxWaitRef.current = null;
    }
  };

  /**
   * 立刻落盘，返回「有没有存干净」；失败会真的报出来（不再静默）。
   * 有保存在飞时先等它落地、再补一轮：保存用的是开始那一刻的快照，
   * 早退的话最后几秒的编辑就静默丢了 —— 返回主页 / 关页面走的正是这条路。
   */
  const flush = useCallback(async function run(): Promise<boolean> {
    for (;;) {
      const inFlight = inFlightRef.current;
      if (inFlight) {
        await inFlight;
        continue;
      }
      const current = reportRef.current;
      if (!current || !isDirty()) return true;
      const target = dirtySeqRef.current;
      let settle!: () => void;
      const done = new Promise<void>((r) => {
        settle = r;
      });
      inFlightRef.current = done;
      setSaveState((s) => ({ ...s, status: "saving" }));
      try {
        await saveProject(current);
        savedSeqRef.current = Math.max(savedSeqRef.current, target);
        lastSavedAtRef.current = Date.now();
        clearMaxWait();
        setSaveState({ status: "saved", at: Date.now() });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setSaveState({ status: "error", message });
        setError(`保存失败：${message}。内容还在页面上，请先「导出 JSON」备份，或清理图片后重试。`);
        return false;
      } finally {
        inFlightRef.current = null;
        settle();
      }
    }
  }, []);

  // 输入变化 → 防抖 700ms；同时挂一个「最长 3 秒」的兜底，连续打字也不会一直不存
  useEffect(() => {
    if (!report) return;
    if (skipSaveForRef.current === report) {
      skipSaveForRef.current = null;
      return;
    }
    markDirty();
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void flush();
    }, 700);
    if (maxWaitRef.current === null) {
      maxWaitRef.current = window.setTimeout(() => {
        maxWaitRef.current = null;
        void flush();
      }, 3000);
    }
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [report, flush]);

  // 切标签 / 最小化 / 关页面时强制落盘 + 未保存就拦一下
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const onPageHide = () => void flush();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      void flush();
      // 只在「保存确实出问题」或「最近 5 秒内没成功保存过」时拦一下，
      // 平时正常编辑刷新不该被弹窗打扰
      const stale = Date.now() - lastSavedAtRef.current > 5000;
      if (saveStateRef.current.status === "error" || stale) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flush]);

  /* ================= 提示 ================= */

  function notify(msg: string) {
    setToast(msg);
  }

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 8000);
    return () => window.clearTimeout(t);
  }, [error]);

  /* ================= 工程列表 ================= */

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (e) {
      setError(`读取本地数据库失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  function resetSaveState() {
    savedSeqRef.current = dirtySeqRef.current;
    clearMaxWait();
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setSaveState({ status: "idle" });
  }

  async function goHome() {
    if (!(await flush())) {
      // 存上了才走：这里清标记等于把刚才的编辑丢掉
      setError("刚才的改动没能存进本地数据库，先别返回。点右上角「保存状态」重试，或先「导出 JSON」备份。");
      return;
    }
    resetSaveState();
    clearHistory();
    setReportState(null);
    setPageIndex(0);
    void refreshProjects();
  }

  async function openProject(id: string) {
    try {
      const loaded = await loadProject(id);
      if (!loaded) {
        setError("这个工程读不出来了（本地数据库里没有这条记录）");
        void refreshProjects();
        return;
      }
      resetSaveState();
      clearHistory();
      skipSaveForRef.current = loaded;
      setReportState(loaded);
      setPageIndex(0);
      setResumeId(id);
      try { localStorage.setItem("lab-report-wizard:last-project", id); } catch { /* ignore */ }
    } catch (e) {
      setError(`打开失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function newProject() {
    const fresh = createReferenceReport();
    try {
      await saveProject(fresh);
    } catch (e) {
      setError(`新建失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    resetSaveState();
    clearHistory();
    setReportState(fresh);
    setPageIndex(0);
    setResumeId(fresh.id);
    try { localStorage.setItem("lab-report-wizard:last-project", fresh.id); } catch { /* ignore */ }
    void refreshProjects();
    notify("已新建工程");
  }

  /** 新建 / 复制 / 导入要落库，这几百毫秒的空档足够双击点出两个工程 */
  const creatingRef = useRef(false);
  async function onceCreating(run: () => Promise<void>): Promise<void> {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      await run();
    } finally {
      creatingRef.current = false;
    }
  }

  async function newFromSkeleton(id: string) {
    const src = await loadProject(id);
    if (!src) return;
    const fresh = createReport(
      { order: src.meta.order, topic: src.meta.topic, studentId: src.meta.studentId, name_: src.meta.name },
      skeletonFrom(src),
    );
    try {
      await saveProject(fresh);
    } catch (e) {
      setError(`新建失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    resetSaveState();
    clearHistory();
    setReportState(fresh);
    setPageIndex(0);
    void refreshProjects();
    notify("已复制骨架新建（内容为空）");
  }

  async function duplicateProject(id: string) {
    const src = await loadProject(id);
    if (!src) return;
    const copy = cloneReport(src);
    try {
      await saveProject(copy);
    } catch (e) {
      setError(`复制失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    void refreshProjects();
    notify(`已复制为「${copy.name}」`);
  }

  async function renameProjectById(id: string, name: string) {
    const target = await loadProject(id);
    if (!target) return;
    try {
      await saveProject({ ...target, name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void refreshProjects();
  }

  async function exportProjectJson(id: string) {
    const target = await loadProject(id);
    if (!target) return;
    downloadJson(exportReportJson(target), `${target.name}.json`);
  }

  async function importProjectJson(file: File) {
    try {
      const text = await file.text();
      const bundle = parseBackupBundle(text);
      if (bundle) {
        const reports = bundleReports(bundle);
        if (!reports.length) {
          setError("这份备份文件里没有任何工程。");
          return;
        }
        const { imported, collided } = await importReports(reports);
        void refreshProjects();
        const missing = bundleMissingImages(bundle);
        notify(
          `已从备份导入 ${imported.length} 个工程` +
            (collided ? `；${collided} 个与现有工程撞号，已另存副本，没动你原来那份` : "") +
            (missing ? `；${missing} 张图片在备份文件里没有内容，位置空着` : ""),
        );
        return;
      }
      const parsed = parseReportJson(text);
      if (!parsed) {
        setError("这个 JSON 读不出来，确认是本工具导出的文件？");
        return;
      }
      const { imported, collided } = await importReports([parsed]);
      void refreshProjects();
      notify(`已导入「${imported[0].name}」${collided ? "（与现有工程撞号，另存了副本，没动原来那份）" : ""}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function importProjectDocx(file: File) {
    try {
      const parsed = await parseDocx(file);
      if (!parsed.items.length) {
        setError("这份 Word 里没读到任何文字段落。");
        return;
      }
      setImportDraft({ fileName: file.name, parsed });
    } catch (e) {
      setError(`Word 模板读取失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function confirmImport(overrides: Map<number, ItemLevel>) {
    const draft = importDraft;
    if (!draft) return;
    if (busy === "import") return; // 压图要几秒，先挡住连点
    setBusy("import");
    let undecodable = 0;
    try {
      const imported = await buildReportFromItems(
        draft.parsed,
        overrides,
        draft.fileName,
        // 原始字节可能是几 MB 的 PNG，入库前统一压成 WebP（≤400KB）
        makeImagePreparer(async (dataUrl) => compressImage(dataUrl), () => (undecodable += 1)),
      );
      await saveProject(imported);
      setResumeId(imported.id);
      try { localStorage.setItem("lab-report-wizard:last-project", imported.id); } catch { /* ignore */ }
      clearHistory();
      setReportState(imported);
      setPageIndex(0);
      setImportDraft(null);
      void refreshProjects();
      const pics = imported.sections.reduce(
        (n, s) => n + s.steps.reduce((m, st) => m + st.blocks.filter((b) => b.kind === "image").length, 0),
        0,
      );
      notify(
        `已导入 ${imported.sections.length} 个小节${pics ? ` / ${pics} 张图` : ""}` +
          (undecodable ? `，${undecodable} 张图片浏览器解不了，位置空着` : ""),
      );
    } catch (e) {
      setError(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function removeProject(id: string) {
    try {
      await deleteProject(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void refreshProjects();
  }

  /* ================= 存储面板 ================= */

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await storageUsage());
      const current = reportRef.current;
      setBackups(current ? await listBackups(current.id) : []);
    } catch {
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    if (settingsOpen) void refreshUsage();
  }, [settingsOpen, refreshUsage]);

  async function handleCleanupAssets() {
    try {
      const removed = await cleanupUnusedAssets();
      notify(removed > 0 ? `已清理 ${removed} 张没被引用的图片` : "没有可清理的图片");
      void refreshUsage();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleExportAll() {
    try {
      downloadJson(await exportAllJson(), `实验报告向导-全部备份-${Date.now()}.json`);
      notify("已导出全部工程");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleExportPdfAndClearBackups() {
    const current = reportRef.current;
    if (!current) return;
    await flush();
    setPrintMode(true);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
    window.print();
    setPrintMode(false);
    if (!confirm("如果刚才已经在打印窗口中选择‘另存为 PDF’，是否清理本工程最近 3 份 JSON 快照？此操作不可恢复。")) return;
    try {
      await clearBackups(current.id);
      notify("PDF 导出流程完成，已清理本工程 JSON 快照");
      void refreshUsage();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRestoreBackup(backupId: string) {
    const current = reportRef.current;
    if (!current) return;
    try {
      const restored = await restoreBackup(current.id, backupId);
      if (!restored) {
        setError("这份快照读不出来了");
        return;
      }
      // 先落库再进编辑器：setReport 之后 reportRef 要等一次渲染才更新，
      // 那时候才 flush 存上去的是恢复前的内容
      await saveProject(restored);
      skipSaveForRef.current = restored;
      clearHistory();
      setReportState(restored);
      resetSaveState();
      void refreshProjects();
      notify("已恢复到所选快照");
    } catch (e) {
      setError(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ================= 内容插入 ================= */

  /**
   * 文字落地：选中的是文字 / 代码块就地合并，否则紧跟在选中块后面，没选中才追加到末尾。
   * 返回是否合并 —— 粘贴和「＋ 插入」必须是同一套位置语义，否则选中了还会粘到文章最后。
   */
  function putText(text: string, blockId: string | null): boolean {
    const p = pageRef.current;
    if (!p || p.kind !== "content") return false;
    const sel = blockId ? p.step.blocks.find((b) => b.id === blockId) : undefined;
    const index = afterBlock(p.step.blocks, blockId);
    const merged = sel?.kind === "text" || sel?.kind === "code";
    setReport((cur) => {
      if (!cur) return cur;
      if (sel?.kind === "text") {
        return updateBlock(cur, p.sectionId, p.stepId, sel.id, { text: sel.text ? `${sel.text}\n${text}` : text });
      }
      if (sel?.kind === "code") {
        return updateBlock(cur, p.sectionId, p.stepId, sel.id, { code: sel.code ? `${sel.code}\n${text}` : text });
      }
      return insertBlock(cur, p.sectionId, p.stepId, textBlock(text), index).report;
    });
    return merged;
  }

  /** 图片落地：选中图片块就是换图，否则紧跟选中块之后。返回是否换了图 */
  function putImage(dataUrl: string, w: number, h: number, blockId: string | null, bytes: number): boolean {
    const p = pageRef.current;
    if (!p || p.kind !== "content") return false;
    const sel = blockId ? p.step.blocks.find((b) => b.id === blockId) : undefined;
    const index = afterBlock(p.step.blocks, blockId);
    const replaced = sel?.kind === "image";
    setReport((cur) => {
      if (!cur) return cur;
      if (sel?.kind === "image") return updateBlock(cur, p.sectionId, p.stepId, sel.id, { dataUrl, w, h });
      return insertBlock(cur, p.sectionId, p.stepId, imageBlock(dataUrl, w, h), index).report;
    });
    if (bytes > IMAGE_WARN_BYTES) {
      notify(`图片已插入（压缩后 ${formatBytes(bytes)}，仍偏大，会影响存储和导出体积）`);
    }
    return replaced;
  }

  async function captureInto(blockId: string | null) {
    setBusy("capture");
    setError(null);
    try {
      const shot = await captureOnce("window");
      const replaced = putImage(shot.dataUrl, shot.w, shot.h, blockId, shot.bytes);
      notify(`已截取当前窗口并${replaced ? "替换选中图片" : "插入"}（${formatBytes(shot.bytes)}）`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Permission|denied|cancel|NotAllowed/i.test(msg)) setError(`截图失败：${msg}`);
    } finally {
      setBusy(null);
    }
  }

  async function clipboardImageInto(blockId: string | null) {
    setBusy("clipboard");
    setError(null);
    try {
      const blob = await readClipboardImage();
      if (!blob) {
        setError("剪贴板里没有图片。用 Win+Shift+S 截一张，或在纸面空白处直接 Ctrl+V。");
        return;
      }
      const img = await compressImage(blob);
      const replaced = putImage(img.dataUrl, img.w, img.h, blockId, img.bytes);
      notify(`已从剪贴板${replaced ? "替换选中图片" : "插入图片"}（${formatBytes(img.bytes)}）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function clipboardTextInto(blockId: string | null) {
    setBusy("clipboard");
    setError(null);
    try {
      const text = await readClipboardText();
      if (!text) {
        setError("剪贴板里没有文本。");
        return;
      }
      putText(text, blockId);
      notify("已粘贴文本");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function uploadInto(file: File, blockId: string | null) {
    setBusy("clipboard");
    setError(null);
    try {
      const img = await compressImage(file);
      putImage(img.dataUrl, img.w, img.h, blockId, img.bytes);
      notify(`图片已插入（${formatBytes(img.bytes)}）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLElement>) {
    const t = e.target as HTMLElement;
    if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable) return;
    const p = pageRef.current;
    if (!p || p.kind !== "content") return;

    const img = imageFromClipboardEvent(e.nativeEvent);
    if (img) {
      e.preventDefault();
      void (async () => {
        try {
          const shot = await compressImage(img);
          const replaced = putImage(shot.dataUrl, shot.w, shot.h, selectedBlockId, shot.bytes);
          notify(`${replaced ? "已用剪贴板图片替换选中图片" : "已粘贴截图"}（${formatBytes(shot.bytes)}）`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
      return;
    }
    const text = textFromClipboardEvent(e.nativeEvent);
    if (text) {
      e.preventDefault();
      notify(putText(text, selectedBlockId) ? "已粘贴进选中的块" : "已粘贴为新文字块");
    }
  }

  /* ================= 导出 ================= */

  function openExportDialog() {
    setAutoCaption(false);
    setExportOpen(true);
  }

  async function handleExport() {
    const current = reportRef.current;
    if (!current) return;
    setBusy("export");
    setError(null);
    try {
      await flush();
      const result = await downloadReport(current, { autoFigureCaptions: autoCaption });
      notify(`已生成 ${result.fileName}`);
      setExportOpen(false);
      // 文件是生成了，但里面少了东西 —— 只弹 toast 会让人以为交出去的是完整的
      if (result.warnings.length) setError(result.warnings.join("；"));
    } catch (e) {
      setError(`生成 Word 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  /* 快捷键：Ctrl+S 立刻保存 */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (reportRef.current) {
          markDirty();
          void flush().then((ok) => {
            if (ok) notify("已保存到本地");
          });
        }
      }
      if (e.key === "Escape") setSettingsOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush]);

  /* ================= 标题编号（唯一来源） ================= */

  const headings = useMemo<Headings>(
    () => (report ? computeHeadings(report) : { step: () => null, section: () => null }),
    [report],
  );

  /* ================= 段内四级序号：同一步骤里的文字块按文档顺序接着数 ================= */

  const numberingLines = useMemo<SeqLine[]>(
    () => (page?.kind === "content" ? page.step.blocks.flatMap((b) => (b.kind === "text" ? [{ blockId: b.id, text: b.text }] : [])) : []),
    [page],
  );

  /* ================= 图片编号 ================= */

  const figureNos = useMemo(() => {
    const map = new Map<string, number>();
    let n = 0;
    report?.sections.forEach((s) =>
      s.steps.forEach((st) =>
        st.blocks.forEach((b) => {
          if (b.kind === "image") {
            n += 1;
            map.set(b.id, n);
          }
        }),
      ),
    );
    return map;
  }, [report]);

  /* ================= 首页 ================= */

  if (!report) {
    return (
      <>
        <Home
          projects={projects}
          onOpen={(id) => void openProject(id)}
          onNew={() => void onceCreating(newProject)}
          onCreateFrom={(id) => void onceCreating(() => newFromSkeleton(id))}
          onDuplicate={(id) => void onceCreating(() => duplicateProject(id))}
          onDelete={(id) => void removeProject(id)}
          onRename={(id, name) => void renameProjectById(id, name)}
          onExportJson={(id) => void exportProjectJson(id)}
          onImportJson={(f) => void onceCreating(() => importProjectJson(f))}
          onImportDocx={(f) => void importProjectDocx(f)}
          resumeProject={resumeId ? projects.find((p) => p.id === resumeId) : undefined}
          onResume={resumeId ? () => void openProject(resumeId) : undefined}
        />
        {importDraft && (
          <ImportPreview
            fileName={importDraft.fileName}
            parsed={importDraft.parsed}
            busy={busy === "import"}
            onClose={() => {
              if (busy !== "import") setImportDraft(null);
            }}
            onConfirm={(overrides) => void confirmImport(overrides)}
          />
        )}
        {toast && <div className="toast">{toast}</div>}
        {error && (
          <div className="error-bar">
            <span>{error}</span>
            <button className="icon" onClick={() => setError(null)}>
              ✕
            </button>
          </div>
        )}
      </>
    );
  }

  /* ================= 编辑器 ================= */

  const progress = projectProgress(report);
  const deadline = planDeadline(report.meta.due, progress.total - progress.done);
  const isCover = page.kind === "cover";
  const stepLabel = page.kind === "content" ? headings.step(`${page.sectionId}:${page.stepId}`) : null;

  const blockApi: BlockApi = {
    patch: (blockId, patch) => {
      if (page.kind !== "content") return;
      setReport((r) => (r ? updateBlock(r, page.sectionId, page.stepId, blockId, patch) : r), `text:${blockId}`);
    },
    remove: (blockId) => {
      if (page.kind !== "content") return;
      setReport((r) => (r ? removeBlock(r, page.sectionId, page.stepId, blockId) : r));
    },
    move: (blockId, delta) => {
      if (page.kind !== "content") return;
      setReport((r) => (r ? moveBlock(r, page.sectionId, page.stepId, blockId, delta) : r));
    },
    captureInto: (id) => void captureInto(id),
    clipboardImageInto: (id) => void clipboardImageInto(id),
    clipboardTextInto: (id) => void clipboardTextInto(id),
    uploadInto: (f, id) => void uploadInto(f, id),
  };

  function addBlockHere(kind: BlockKind) {
    if (page.kind !== "content") return;
    setReport((r) => {
      if (!r) return r;
      const index = afterBlock(page.step.blocks, selectedBlockId);
      const out =
        index === undefined
          ? addBlock(r, page.sectionId, page.stepId, kind)
          : insertBlockAt(r, page.sectionId, page.stepId, index, kind);
      setSelectedBlockId(out.blockId);
      return out.report;
    });
  }

  const saveLabel =
    saveState.status === "saving"
      ? "保存中…"
      : saveState.status === "saved"
        ? `已保存 ${saveState.at ? clockTime(saveState.at) : ""}`
        : saveState.status === "error"
          ? "⚠ 保存失败"
          : "未改动";

  return (
    <>
    <div className={`app${printMode ? " is-printing" : ""}`}>
      <header className="topbar">
        <span className="brand-mark">W</span>
        <button className="icon" title="返回工程列表" onClick={() => void goHome()}>
          ←
        </button>
        <div className="topbar-title">
          <span className="proj-title">{report.name}</span>
          <span className="muted">
            {progress.done}/{progress.total} 项已填
          </span>
        </div>

        <button
          className={`save-pill ${saveState.status}`}
          title={
            saveState.status === "error"
              ? `${saveState.message ?? ""}（点击重试）`
              : "点击立刻保存（Ctrl+S）"
          }
          onClick={() => {
            markDirty();
            void flush();
          }}
        >
          <span className="save-dot" />
          {saveLabel}
        </button>

        <span className="spacer" />
        <button className="btn" onClick={() => setSettingsOpen(true)}>
          ⚙ 设置
        </button>
        <button className="btn btn-primary" onClick={openExportDialog} disabled={busy === "export"}>
          {busy === "export" ? "生成中…" : "⬇ 导出 Word"}
        </button>
      </header>

      <main className="main">
        <Outline
          report={report}
          currentKey={page.key}
          onJump={(key) => {
            const i = pages.findIndex((p) => p.key === key);
            if (i >= 0) setPageIndex(i);
          }}
          onAddStep={(sectionId) => setReport((r) => (r ? addStep(r, sectionId).report : r))}
          onRemoveStep={(sectionId, stepId) => setReport((r) => (r ? removeStep(r, sectionId, stepId) : r))}
          onMoveStep={(sectionId, stepId, d) => setReport((r) => (r ? moveStep(r, sectionId, stepId, d) : r))}
          onMoveSection={(sectionId, d) => setReport((r) => (r ? moveSection(r, sectionId, d) : r))}
          onAddSection={() => setReport((r) => (r ? addSection(r).report : r))}
          onRemoveSection={(sectionId) => setReport((r) => (r ? removeSection(r, sectionId) : r))}
          onRenameSection={(sectionId, title) => setReport((r) => (r ? updateSectionTitle(r, sectionId, title) : r), `secTitle:${sectionId}`)}
        />

        <section className={`stage${isCover ? " stage-cover" : ""}`} onPaste={handlePaste}>
          <div className="stage-caption"><span>{isCover ? "封面设计" : page.label}</span><span>A4 · {report.cover.style === "reference" ? "课程报告" : "实验报告"} · 排版预览</span></div>
          {!isCover && (
            <div className="stage-bar">
              <span className="insert-menu" onKeyDown={(e) => e.key === "Escape" && setInsertOpen(false)}>
                <button className="btn btn-sm" aria-expanded={insertOpen} onClick={() => setInsertOpen((v) => !v)}>
                  ＋ 插入 ▾
                </button>
                {insertOpen && (
                  <>
                    <span className="project-menu-mask" onClick={() => setInsertOpen(false)} />
                    <div className="insert-menu-items">
                      {(["text", "code", "image", "table"] as BlockKind[]).map((k) => (
                        <button
                          key={k}
                          onClick={() => {
                            setInsertOpen(false);
                            addBlockHere(k);
                          }}
                        >
                          {{ text: "文字", code: "代码", image: "图片", table: "表格" }[k]}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </span>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => void captureInto(null)}>
                {busy === "capture" ? "截取中…" : "截取当前窗口"}
              </button>
              <span className="toolbar-hint muted">剪贴板里的图片 / 文字，在纸面上按 Ctrl+V 就能贴 · 删错了 Ctrl+Z 撤回</span>
              {deadline && <span className={`deadline-badge ${deadlineTone(deadline)}`}>{deadlineLabel(deadline)}</span>}
            </div>
          )}

          <div className={`paper${report.cover.style === "reference" ? " paper-reference" : ""}`} data-page={page.kind}>
            {page.kind === "cover" ? (
              <CoverPreview report={report} />
            ) : (
              <>
                {page.section.mode === "plain" ? (
                  <SectionHeading label={headings.section(page.sectionId)} title={page.section.title} options={report.options} />
                ) : (
                  <StepHeading
                    label={stepLabel}
                    title={page.step.title}
                    options={report.options}
                    onTitle={(t) => setReport((r) => (r ? updateStepTitle(r, page.sectionId, page.stepId, t) : r), `stepTitle:${page.stepId}`)}
                  />
                )}

                {page.step.blocks.length === 0 && (
                  <div className="paper-empty">
                    这一页还没有内容。用上面的「＋ 插入」加一段文字，或者直接在纸面上按{" "}
                    <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴截图。
                  </div>
                )}

                {page.step.blocks.map((block, i) => (
                  <BlockCard
                    key={block.id}
                    block={block}
                    index={i}
                    options={report.options}
                    api={blockApi}
                    busy={busy}
                    figureNo={figureNos.get(block.id)}
                    numbering={numberingLines}
                    selected={selectedBlockId === block.id}
                    onSelect={setSelectedBlockId}
                  />
                ))}

                <button className="paper-add" onClick={() => addBlockHere("text")}>
                  ＋ 在末尾加一段
                </button>
              </>
            )}
          </div>

          <aside className="inspector" hidden={page.kind !== "cover"}>
          <div className="inspector-head"><strong>文档设置</strong><span>修改会自动保存</span></div>
          {page.kind === "cover" && (
            <CoverPanel report={report} onCover={(patch) => setReport((r) => (r ? updateCover(r, patch) : r), `cover:${Object.keys(patch).join(",")}`)} />
          )}

          {page.kind === "cover" && (
            <div className="panel">
              <div className="panel-title">实验信息</div>
              <div className="field-row">
                <label className="field narrow">
                  实验序号
                  <input
                    value={report.meta.order}
                    placeholder="十一"
                    onChange={(e) => setReport((r) => (r ? updateMeta(r, { order: e.target.value }) : r), "meta:order")}
                  />
                </label>
                <label className="field">
                  实验主题
                  <input
                    value={report.meta.topic}
                    placeholder="属性查询与空间查询"
                    onChange={(e) => setReport((r) => (r ? updateMeta(r, { topic: e.target.value }) : r), "meta:topic")}
                  />
                </label>
                <label className="field narrow">
                  学号
                  <input
                    value={report.meta.studentId}
                    placeholder="填写学号"
                    onChange={(e) => setReport((r) => (r ? updateMeta(r, { studentId: e.target.value }) : r), "meta:studentId")}
                  />
                </label>
                <label className="field narrow">
                  姓名
                  <input
                    value={report.meta.name}
                    placeholder="填写姓名"
                    onChange={(e) => setReport((r) => (r ? updateMeta(r, { name: e.target.value }) : r), "meta:name")}
                  />
                </label>
                <label className="field narrow">
                  日期
                  <input
                    value={report.meta.date}
                    onChange={(e) => setReport((r) => (r ? updateMeta(r, { date: e.target.value }) : r), "meta:date")}
                  />
                </label>
                <label className="field narrow">
                  截止日期
                  <input
                    type="date"
                    value={report.meta.due}
                    onChange={(e) => setReport((r) => (r ? updateMeta(r, { due: e.target.value }) : r), "meta:due")}
                  />
                </label>
              </div>
            </div>
          )}
          </aside>
        </section>
      </main>

      <WizardBar
        index={safeIndex}
        total={pages.length}
        label={page.label}
        filled={page.filled}
        busy={busy === "export"}
        onPrev={() => setPageIndex((i) => Math.max(0, i - 1))}
        onNext={() => setPageIndex((i) => Math.min(pages.length - 1, i + 1))}
        onFinish={openExportDialog}
        onHome={() => void goHome()}
      />

      {settingsOpen && (
        <SettingsModal
          report={report}
          usage={usage}
          backups={backups}
          onClose={() => setSettingsOpen(false)}
          onOptions={(patch) => setReport((r) => (r ? updateOptions(r, patch) : r))}
          onRename={(name) => setReport((r) => (r ? renameProject(r, name) : r))}
          onExportJson={() => downloadJson(exportReportJson(report), `${report.name}.json`)}
          onExportMarkdown={() => notify(`已导出 ${downloadMarkdown(report)}`)}
          onExportAll={() => void handleExportAll()}
          onExportPdfAndClearBackups={() => void handleExportPdfAndClearBackups()}
          onCleanupAssets={() => void handleCleanupAssets()}
          onRestoreBackup={(id) => void handleRestoreBackup(id)}
          onReset={() => {
            if (!confirm("确定清空全部内容？所有步骤的正文会被删掉（小节结构保留）。删错可用 Ctrl+Z 撤销。")) return;
            setReport((r) => {
              if (!r) return r;
              return {
                ...r,
                sections: r.sections.map((s) => ({
                  ...s,
                  steps: s.steps.map((st) => ({ ...st, blocks: [] as Block[] })),
                })),
                options: { ...DEFAULT_OPTIONS, ...r.options },
              };
            });
          }}
        />
      )}

      {exportOpen && (
        <ExportModal
          fileName={reportFileName(report)}
          busy={busy === "export"}
          autoCaption={autoCaption}
          missingCaptions={report.sections.reduce(
            (n, s) =>
              n +
              s.steps.reduce(
                (m, st) =>
                  m + st.blocks.filter((b) => b.kind === "image" && b.dataUrl.trim() && !b.caption.trim()).length,
                0,
              ),
            0,
          )}
          onAutoCaption={setAutoCaption}
          onCancel={() => {
            if (busy !== "export") setExportOpen(false);
          }}
          onConfirm={() => void handleExport()}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
      {error && (
        <div className="error-bar">
          <span>{error}</span>
          <button className="icon" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
    {printMode && <PrintDocument report={report} />}
    </>
  );
}
