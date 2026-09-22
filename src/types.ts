/**
 * 数据模型
 *   工程(Report) = 元信息 + 封面 + 排版选项 + 若干小节(Section)
 *   小节 = 若干步骤(Step)，步骤 = 若干内容块(Block)
 */

export type Align = "left" | "center" | "right" | "justify";

export type Block =
  | { id: string; kind: "text"; text: string; align: Align; indent?: boolean }
  | { id: string; kind: "code"; lang: string; code: string; showLang: boolean; boxed: boolean }
  | {
      id: string;
      kind: "image";
      dataUrl: string;
      caption: string;
      align: Align;
      /** 0 = 按原始尺寸；否则为正文宽度的百分比 */
      widthPct: number;
      captionPos: "below" | "none";
      /** 原始像素尺寸，插入时记录，导出时用来算高宽比 */
      w: number;
      h: number;
    }
  | { id: string; kind: "table"; rows: string[][]; headerRow: boolean };

export type BlockKind = Block["kind"];

export interface Step {
  id: string;
  /** 步骤标题，例如「添加图形图层」；plain 小节里该字段为空 */
  title: string;
  blocks: Block[];
}

export type SectionMode = "plain" | "steps";

export interface Section {
  id: string;
  /** 二级标题，例如「一、实验目的」 */
  title: string;
  mode: SectionMode;
  /** plain 小节只用一个匿名 step 装内容 */
  steps: Step[];
  required: boolean;
}

export interface Meta {
  /** 实验序号，例如「01」 */
  order: string;
  /** 实验主题 */
  topic: string;
  studentId: string;
  name: string;
  date: string;
  /** 截止日期 YYYY-MM-DD，留空就是不设 deadline */
  due: string;
}

/* ---------------- 封面 ---------------- */

export type CoverStyle = "plain" | "hero" | "reference";

export interface Cover {
  style: CoverStyle;
  /** 留空则自动用「实验N：主题」 */
  title: string;
  /** 副标题，一般是课程名 */
  subtitle: string;
  showMeta: boolean;
}

/* ---------------- 排版选项 ---------------- */

/** 标题编号字形（详见 headings.ts） */
export type HeadGlyph = "none" | "arabic" | "paren" | "alpha" | "chinese" | "roman";
/** 步骤编号在哪重计 */
export type HeadRestart = "section" | "document";

export interface ReportOptions {
  /** 正文字号（半磅），24 = 小四 */
  bodySize: number;
  /** 小节标题字号，32 = 三号 */
  subHeadSize: number;
  /** 步骤标题字号，28 = 四号 */
  stepHeadSize: number;
  /** 报告大标题字号，36 = 小二 */
  titleSize: number;
  bodyFont: string;
  headFont: string;
  lineSpacing: number;
  firstLineIndent: boolean;
  justify: boolean;
  /** 页脚居中页码 */
  pageNumber: boolean;
  /** 自动目录页 */
  toc: boolean;
  /** 步骤标题的编号字形 */
  stepGlyph: HeadGlyph;
  /** 步骤编号在哪重计 */
  stepRestart: HeadRestart;
  /** 小节标题的编号字形；预设骨架已手写「一、二、三」，默认不再叠加 */
  sectionGlyph: HeadGlyph;
  /** 导出文件名模板，支持 {order} {studentId} {name} {topic} {title} {date} */
  fileNamePattern: string;
}

/* ---------------- 工程 ---------------- */

export interface Report {
  id: string;
  /** 工程名，例如「实验01 属性查询」 */
  name: string;
  createdAt: number;
  updatedAt: number;
  meta: Meta;
  cover: Cover;
  options: ReportOptions;
  sections: Section[];
}

/* ---------------- 工具 ---------------- */

let seq = 0;
export function uid(prefix = "id"): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function emptyBlock(kind: BlockKind): Block {
  switch (kind) {
    case "text":
      return { id: uid("b"), kind: "text", text: "", align: "left" };
    case "code":
      return { id: uid("b"), kind: "code", lang: "js", code: "", showLang: true, boxed: true };
    case "image":
      return {
        id: uid("b"),
        kind: "image",
        dataUrl: "",
        caption: "",
        align: "center",
        widthPct: 0,
        captionPos: "below",
        w: 0,
        h: 0,
      };
    case "table":
      return {
        id: uid("b"),
        kind: "table",
        headerRow: true,
        rows: [
          ["项目", "说明"],
          ["", ""],
        ],
      };
  }
}

export function newStep(title = ""): Step {
  return { id: uid("s"), title, blocks: [] };
}

export function textBlock(text: string): Block {
  return { id: uid("b"), kind: "text", text, align: "left" };
}

export function imageBlock(dataUrl: string, w: number, h: number, caption = ""): Block {
  return {
    id: uid("b"),
    kind: "image",
    dataUrl,
    caption,
    align: "center",
    widthPct: 0,
    captionPos: "below",
    w,
    h,
  };
}

/** 判断一个块是否「有内容」 */
export function blockHasContent(b: Block): boolean {
  switch (b.kind) {
    case "text":
      return b.text.trim().length > 0;
    case "code":
      return b.code.trim().length > 0;
    case "image":
      return b.dataUrl.length > 0;
    case "table":
      return b.rows.some((r) => r.some((c) => c.trim().length > 0));
  }
}

export function stepHasContent(step: Step): boolean {
  return step.blocks.some(blockHasContent);
}

export function sectionHasContent(section: Section): boolean {
  return section.steps.some(stepHasContent);
}

/* ---------------- 字号工具 ---------------- */

/** 半磅 → pt 显示，例如 24 → 12pt */
export function sizeLabel(hp: number): string {
  const map: Record<number, string> = {
    84: "初号",
    72: "小初",
    52: "一号",
    48: "小一",
    44: "二号",
    36: "小二",
    32: "三号",
    30: "小三",
    28: "四号",
    24: "小四",
    21: "五号",
    18: "小五",
  };
  return `${hp / 2}pt（${map[hp] ?? "自定义"}）`;
}
