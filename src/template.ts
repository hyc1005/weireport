import {
  emptyBlock,
  newStep,
  uid,
  type Cover,
  type Report,
  type ReportOptions,
  type Section,
} from "./types";
import { defaultStepGlyph } from "./headings";

/** 默认排版：黑体标题 + 宋体正文 + 1.5 倍行距 + 首行缩进，对齐你原来那 7 份报告的体例 */
export const DEFAULT_OPTIONS: ReportOptions = {
  bodySize: 24, // 小四
  subHeadSize: 32, // 三号
  stepHeadSize: 28, // 四号
  titleSize: 36, // 小二
  bodyFont: "宋体",
  headFont: "黑体",
  lineSpacing: 1.5,
  firstLineIndent: true,
  justify: true,
  pageNumber: false,
  toc: false,
  stepGlyph: defaultStepGlyph("plain"),
  // 每小节重新数：预设骨架的二三级关系是「一、二、三 小节 → 1. 2. 3. 步骤」，
  // 全文连续会让「四、课堂任务」下的第一条显示成 3.（接着三的 1. 2. 数），看起来像挂错了父级。
  stepRestart: "section",
  sectionGlyph: "none",
  fileNamePattern: "实验{order}_{studentId}_{name}_{topic}",
};

export const DEFAULT_COVER: Cover = {
  style: "plain",
  title: "",
  subtitle: "",
  showMeta: true,
};

/** 默认骨架：一、实验目的 / 二、实验内容 / 三、实验步骤 / 四、课堂任务 / 五、实验总结 */
export function presetSections(): Section[] {
  return [
    {
      id: uid("sec"),
      title: "一、实验目的",
      mode: "plain",
      required: true,
      steps: [withBlocks(newStep())],
    },
    {
      id: uid("sec"),
      title: "二、实验内容",
      mode: "plain",
      required: true,
      steps: [withBlocks(newStep())],
    },
    {
      id: uid("sec"),
      title: "三、实验步骤",
      mode: "steps",
      required: true,
      steps: [newStep(), newStep(), newStep()],
    },
    {
      id: uid("sec"),
      title: "四、课堂任务",
      mode: "steps",
      required: false,
      steps: [newStep()],
    },
    {
      id: uid("sec"),
      title: "五、实验总结",
      mode: "plain",
      required: true,
      steps: [withBlocks(newStep())],
    },
  ];
}

function withBlocks(step: ReturnType<typeof newStep>) {
  step.blocks.push(emptyBlock("text"));
  return step;
}

export function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export interface CreateReportInput {
  name?: string;
  order?: string;
  topic?: string;
  studentId?: string;
  name_?: string;
}

/* ---------------- 这台机器上的作者信息 ---------------- */

/**
 * 学号 / 姓名是「这台机器上的人」，不是某个工程的属性：单独存在 localStorage 里，
 * 新建工程自动带上，下次打开就不用再手填。**只放在本机**，不随工程导出、不上云。
 * （工程正文仍然只进 IndexedDB —— localStorage 那 5 MB 装不下截图，这里只放两行字。）
 */
export interface AuthorPrefs {
  studentId: string;
  name: string;
}

export const AUTHOR_PREFS_KEY = "lab-report-wizard:author";

export function readAuthorPrefs(): AuthorPrefs | null {
  try {
    const raw = localStorage.getItem(AUTHOR_PREFS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as { studentId?: unknown; name?: unknown };
    const studentId = typeof obj.studentId === "string" ? obj.studentId : "";
    const name = typeof obj.name === "string" ? obj.name : "";
    return studentId || name ? { studentId, name } : null;
  } catch {
    return null; // 无 localStorage / 存坏了的 JSON：当没填过，绝不因此挡住新建工程
  }
}

/** 返回 true = 这次真的写进去了（界面上要弹「已记住」提示时看这个） */
export function saveAuthorPrefs(prefs: AuthorPrefs): boolean {
  try {
    localStorage.setItem(AUTHOR_PREFS_KEY, JSON.stringify({ studentId: prefs.studentId.trim(), name: prefs.name.trim() }));
    return true;
  } catch {
    return false; // 配额满 / 隐私模式禁写：记不住不影响本次编辑
  }
}

/** 忘掉记下来的作者信息（设置里给一个反悔的口子） */
export function clearAuthorPrefs(): void {
  try {
    localStorage.removeItem(AUTHOR_PREFS_KEY);
  } catch {
    /* ignore */
  }
}

/** 只补「学号 / 姓名还空着」的工程（老工程、导入件都走这里），填过的绝不覆盖 */
export function withStoredAuthor(report: Report): Report {
  if (report.meta.studentId || report.meta.name) return report;
  const prefs = readAuthorPrefs();
  if (!prefs) return report;
  return { ...report, meta: { ...report.meta, studentId: prefs.studentId, name: prefs.name } };
}

/** 新建一个工程；想复用旧骨架时把 sections 传进来即可 */
export function createReport(input: CreateReportInput = {}, sections?: Section[]): Report {
  const now = Date.now();
  const order = input.order ?? "01";
  const topic = input.topic ?? "";
  const prefs = readAuthorPrefs();
  return {
    id: uid("proj"),
    name: input.name ?? `实验${order}${topic ? ` ${topic}` : ""}`,
    createdAt: now,
    updatedAt: now,
    meta: {
      order,
      topic,
      // 没显式给学号/姓名时，自动带上这台机器上次填的（新建工程不用再手填）
      studentId: input.studentId ?? prefs?.studentId ?? "",
      name: input.name_ ?? prefs?.name ?? "",
      date: todayString(),
      due: "",
    },
    cover: { ...DEFAULT_COVER },
    options: { ...DEFAULT_OPTIONS },
    sections: sections ?? presetSections(),
  };
}

/** 只抄结构、不抄内容：拿旧工程的小节骨架新建（步骤标题保留，块清空） */
export function skeletonFrom(report: Report): Section[] {
  return report.sections.map((s) => ({
    id: uid("sec"),
    title: s.title,
    mode: s.mode,
    required: s.required,
    steps: s.steps.map((st) => ({
      id: uid("s"),
      title: st.title,
      blocks: st.blocks.length > 0 ? [emptyBlock(st.blocks[0].kind === "image" ? "text" : st.blocks[0].kind)] : [],
    })),
  }));
}

export const PRESET_SECTIONS = [
  "一、实验目的",
  "二、实验内容",
  "三、实验步骤",
  "四、课堂任务",
  "五、实验总结",
  "六、遇到的问题",
  "七、参考资料",
];
