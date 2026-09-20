/**
 * docx 直出内核
 *   不再走「Markdown → 第三方库 → 正则改 XML」，而是直接由块模型生成 OOXML。
 *   这样才能做到：真·标题级别（含大纲级别，导航窗格/自动目录可用）、逐块对齐、
 *   封面独立成页、页码、自动目录、图片精确尺寸。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  LineRuleType,
  PageNumber,
  Packer,
  Paragraph,
  SectionType,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TableOfContents,
  TextRun,
  WidthType,
  type ISectionOptions,
} from "docx";
import { autoTitle, coverHasOwnPage, metaLine } from "../cover";
import { countForNumbering, computeHeadings } from "../headings";
import { parsePrefix } from "../numbering";
import { sectionHasContent, type Align, type Block, type Report, type ReportOptions } from "../types";

/* ---------------- 版面常量（A4 + 你原来文档的页边距） ---------------- */

const PAGE = { width: 11906, height: 16838 }; // A4 twips
const MARGIN = { top: 1440, right: 1080, bottom: 1440, left: 1080 };
const CONTENT_WIDTH_TWIP = PAGE.width - MARGIN.left - MARGIN.right; // 9746

const HEAD_COLOR = "1A1A1A";
const BODY_COLOR = "262626";
const SUB_COLOR = "595959";
const CODE_BG = "F6F7F9";
const CODE_LINE = "E4E7EB";
const TABLE_HEAD_BG = "F2F3F5";

/* ---------------- 小工具 ---------------- */

type Fonts = { ascii: string; hAnsi: string; eastAsia: string; cs: string };

function fonts(eastAsia: string, latin = "Times New Roman"): Fonts {
  return { ascii: latin, hAnsi: latin, eastAsia, cs: latin };
}

function alignmentOf(a: Align) {
  switch (a) {
    case "center":
      return AlignmentType.CENTER;
    case "right":
      return AlignmentType.RIGHT;
    case "justify":
      return AlignmentType.JUSTIFIED;
    default:
      return AlignmentType.LEFT;
  }
}

function spacing(o: ReportOptions, before = 0, after = 0) {
  return { before, after, line: Math.round(240 * o.lineSpacing), lineRule: LineRuleType.AUTO };
}

/** 极简行内格式：**加粗**、*斜体*、`行内代码` */
function inlineRuns(text: string, o: ReportOptions): TextRun[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g).filter((s) => s !== "");
  return parts.map((part) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return new TextRun({ text: part.slice(2, -2), bold: true });
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return new TextRun({ text: part.slice(1, -1), italics: true });
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return new TextRun({
        text: part.slice(1, -1),
        font: fonts(o.bodyFont, "Consolas"),
        size: Math.max(18, o.bodySize - 2),
        color: "9A3412",
      });
    }
    return new TextRun({ text: part });
  });
}

type ImageData = { type: "jpg" | "png" | "gif" | "bmp"; data: Uint8Array };

function dataUrlToImage(dataUrl: string): ImageData | null {
  const m = /^data:image\/(png|jpe?g|gif|bmp);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const type: ImageData["type"] = kind === "jpeg" || kind === "jpg" ? "jpg" : (kind as "png" | "gif" | "bmp");
  try {
    const bin = atob(m[2].replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return { type, data: bytes };
  } catch {
    return null;
  }
}

/* ---------------- 样式表 ---------------- */

function buildStyles(o: ReportOptions, reference = false) {
  const line = Math.round(240 * o.lineSpacing);
  const head = (size: number, outline: number, before: number, after: number) => ({
    run: { font: fonts(o.headFont), size, bold: true, color: reference ? "0F4761" : HEAD_COLOR },
    paragraph: {
      outlineLevel: outline,
      spacing: { before, after, line, lineRule: LineRuleType.AUTO },
      keepNext: true,
    },
  });

  return {
    default: {
      document: {
        run: { font: fonts(o.bodyFont), size: o.bodySize, color: BODY_COLOR },
        paragraph: { spacing: { before: 0, after: 0, line, lineRule: LineRuleType.AUTO } },
      },
      // 一级 = 报告大标题，二级 = 一、二、三小节，三级 = 1. 2. 3. 步骤
      heading1: {
        ...head(o.titleSize, 0, 120, 240),
        paragraph: { ...head(o.titleSize, 0, 120, 240).paragraph, alignment: AlignmentType.CENTER },
      },
      heading2: head(o.subHeadSize, 1, 320, 140),
      heading3: head(o.stepHeadSize, 2, 220, 100),
    },
  };
}

/* ---------------- 封面 ---------------- */

function blank(count = 1): Paragraph[] {
  return Array.from({ length: count }, () => new Paragraph({ spacing: { after: 0 } }));
}

function bigCenterTitle(report: Report, size: number): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 240, line: 360, lineRule: LineRuleType.AUTO },
    children: [
      new TextRun({ text: autoTitle(report), font: fonts(report.options.headFont), size, bold: true, color: HEAD_COLOR }),
    ],
  });
}

/** 正式风：上留白 + 特大标题 + 副标题 + 学号姓名日期，尾部由外层分页 */
function heroCover(report: Report): Paragraph[] {
  const o = report.options;
  const size = Math.max(o.titleSize, 44);
  const kids: Paragraph[] = [...blank(6), bigCenterTitle(report, size)];

  if (report.cover.subtitle.trim()) {
    kids.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: report.cover.subtitle.trim(), font: fonts(o.headFont), size: 32, color: SUB_COLOR })],
      }),
    );
  }

  kids.push(...blank(4));

  if (report.cover.showMeta) {
    const { studentId, name, date } = report.meta;
    const line = (text: string) =>
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160, line: 400, lineRule: LineRuleType.AUTO },
        children: [new TextRun({ text, size: 32 })],
      });
    if (studentId) kids.push(line(`学号：${studentId}`));
    if (name) kids.push(line(`姓名：${name}`));
    if (report.cover.subtitle.trim()) kids.push(line(`课程：${report.cover.subtitle.trim()}`));
    if (date) kids.push(...blank(2), line(date));
  }
  return kids;
}

function referenceCover(report: Report): Paragraph[] {
  const o = report.options;
  const line = (text: string, size: number, before: number, after = 160) => new Paragraph({
    spacing: { before, after, line: 360, lineRule: LineRuleType.AUTO },
    children: [new TextRun({ text, size, font: fonts(o.bodyFont), color: "111111" })],
  });
  const kids = [new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 930, after: 360, line: 300, lineRule: LineRuleType.AUTO },
    children: [new TextRun({ text: report.cover.title.trim() || `实验${report.meta.order}`, size: 128, font: fonts(o.bodyFont), color: "111111" })],
  })];
  if (report.meta.topic) kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [new TextRun({ text: report.meta.topic, size: 36 })] }));
  if (report.cover.subtitle.trim()) kids.push(line(`课程：${report.cover.subtitle.trim()}`, 44, 3800, 320));
  if (report.cover.showMeta) {
    kids.push(line(`学号：${report.meta.studentId || "________________"}`, 40, report.cover.subtitle.trim() ? 0 : 3800));
    kids.push(line(`姓名：${report.meta.name || "________________"}`, 40, 0));
    if (report.meta.date) kids.push(line(report.meta.date, 24, 360));
  }
  return kids;
}

/** 简洁风：不占独立页，首行标题 + 一行学号姓名日期 */
function plainCover(report: Report): Paragraph[] {
  const o = report.options;
  const kids: Paragraph[] = [
    // 简洁风的标题同样走 Heading1，保证 Word 导航窗格/目录能认出来
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.LEFT,
      spacing: { after: 120, line: 400, lineRule: LineRuleType.AUTO },
      children: [
        new TextRun({ text: autoTitle(report), font: fonts(o.headFont), size: o.titleSize, bold: true, color: HEAD_COLOR }),
      ],
    }),
  ];
  if (report.cover.subtitle.trim()) {
    kids.push(
      new Paragraph({
        spacing: { after: 100 },
        children: [new TextRun({ text: report.cover.subtitle.trim(), size: 24, color: SUB_COLOR })],
      }),
    );
  }
  if (report.cover.showMeta && metaLine(report)) {
    kids.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [new TextRun({ text: metaLine(report), size: 21, color: SUB_COLOR })],
      }),
    );
  }
  return kids;
}

/* ---------------- 内容块 ---------------- */

function textBlockChildren(block: Extract<Block, { kind: "text" }>, o: ReportOptions): Paragraph[] {
  const lines = block.text.replace(/\r\n/g, "\n").split("\n");
  const centered = block.align === "center" || block.align === "right";
  const indentOn = (block.indent ?? o.firstLineIndent) && !centered;
  return lines
    .filter((l) => l.trim() !== "")
    .map(
      (line) =>
        new Paragraph({
          alignment: alignmentOf(block.align === "left" && o.justify ? "justify" : block.align),
          // 带序号的行（（1）/ a) / ① …）不再加首行缩进，靠序号自己对齐
          indent:
            indentOn && parsePrefix(line) === null
              ? { firstLineChars: 200, firstLine: o.bodySize * 20 }
              : undefined,
          spacing: spacing(o, 0, 60),
          children: inlineRuns(line.trimEnd(), o),
        }),
    );
}

function codeBlockChild(block: Extract<Block, { kind: "code" }>, o: ReportOptions, contentWidth: number): Table {
  const lines = block.code.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  const body = lines.map(
    (line) =>
      new Paragraph({
        spacing: { before: 0, after: 0, line: Math.round(o.bodySize * 18), lineRule: LineRuleType.EXACT },
        children: [
          new TextRun({
            text: line === "" ? " " : line,
            font: fonts(o.bodyFont, "Consolas"),
            size: Math.max(16, o.bodySize - 4),
            color: "33383D",
          }),
        ],
      }),
  );

  const children: Paragraph[] = [];
  if (block.showLang && block.lang && block.lang !== "纯文本") {
    children.push(
      new Paragraph({
        spacing: { before: 0, after: 40 },
        children: [new TextRun({ text: block.lang, font: fonts(o.bodyFont, "Consolas"), size: 17, color: "8A9099" })],
      }),
    );
  }
  children.push(...body);

  const border = block.boxed ? { style: BorderStyle.SINGLE, size: 4, color: CODE_LINE } : undefined;

  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths: [contentWidth],
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: block.boxed ? { type: ShadingType.CLEAR, color: "auto", fill: CODE_BG } : undefined,
            margins: { top: 140, bottom: 140, left: 220, right: 220 },
            children,
          }),
        ],
      }),
    ],
  });
}

/** 一张图导出失败的位置，用来拼给用户看的提醒 */
interface DroppedImage {
  where: string;
  caption: string;
}

function captionParagraph(block: Extract<Block, { kind: "image" }>, o: ReportOptions): Paragraph | null {
  const text = block.caption.trim();
  if (!text || block.captionPos !== "below") return null;
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: spacing(o, 0, 200),
    children: [new TextRun({ text, size: 21, color: SUB_COLOR })],
  });
}

function imageBlockChildren(
  block: Extract<Block, { kind: "image" }>,
  o: ReportOptions,
  contentWidth: number,
  where: string,
  dropped: DroppedImage[],
): Paragraph[] {
  const img = dataUrlToImage(block.dataUrl);
  if (!img) {
    // 空的图片块整块丢掉（跟空代码块一样）；有数据却读不出来的必须吱一声
    if (!block.dataUrl.trim()) return [];
    dropped.push({ where, caption: block.caption.trim() });
    // 图没了至少把图注留下，否则交出去的文件里连「这里本该有一张图」都看不出来
    const caption = captionParagraph(block, o);
    return caption ? [caption] : [];
  }

  // 脏数据（0 / 负数 / NaN / Infinity）一律回退，绝不写出 cx="0"——Word 会显示成坏图
  const contentWidthPx = Math.max(1, Math.round(contentWidth / 15));
  const pos = (v: number, fallback: number) => (Number.isFinite(v) && v > 0 ? v : fallback);
  const naturalW = pos(block.w, Math.round(contentWidthPx * 0.8));
  const naturalH = pos(block.w > 0 ? block.h : 0, Math.round(naturalW * 0.62));
  const pct = pos(block.widthPct, 0);
  const width = pos(pct > 0 ? (contentWidthPx * pct) / 100 : naturalW, naturalW);
  const out: Paragraph[] = [
    new Paragraph({
      alignment: alignmentOf(block.align),
      keepNext: block.captionPos === "below" && !!block.caption.trim(),
      spacing: spacing(o, 120, block.caption && block.captionPos === "below" ? 60 : 160),
      children: [
        new ImageRun({
          ...img,
          transformation: {
            width: Math.max(1, Math.min(Math.round(width), contentWidthPx)),
            height: Math.max(1, Math.round((width * naturalH) / naturalW)),
          },
          altText: { name: block.caption || "报告插图", description: block.caption || "报告插图" },
        }),
      ],
    }),
  ];

  const caption = captionParagraph(block, o);
  if (caption) out.push(caption);
  return out;
}

function tableBlockChild(block: Extract<Block, { kind: "table" }>, o: ReportOptions, contentWidth: number): Table | null {
  const rows = block.rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  const colWidth = Math.floor(contentWidth / cols);
  const border = { style: BorderStyle.SINGLE, size: 4, color: "B9BFC7" };

  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths: Array.from({ length: cols }, () => colWidth),
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: rows.map((row, ri) => {
      const isHead = ri === 0 && block.headerRow;
      return new TableRow({
        tableHeader: isHead,
        children: Array.from({ length: cols }, (_, ci) => {
          const text = row[ci] ?? "";
          return new TableCell({
            shading: isHead ? { type: ShadingType.CLEAR, color: "auto", fill: TABLE_HEAD_BG } : undefined,
            margins: { top: 100, bottom: 100, left: 160, right: 160 },
            children: [
              new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 0, after: 0, line: Math.round(240 * o.lineSpacing), lineRule: LineRuleType.AUTO },
                children: inlineRuns(text, o).map((r) => r),
              }),
            ],
          });
        }),
      });
    }),
  });
}

function blockChildren(
  block: Block,
  o: ReportOptions,
  contentWidth: number,
  where: string,
  dropped: DroppedImage[],
): Array<Paragraph | Table> {
  switch (block.kind) {
    case "text":
      return textBlockChildren(block, o);
    case "code":
      return block.code.trim() ? [codeBlockChild(block, o, contentWidth)] : [];
    case "image":
      return imageBlockChildren(block, o, contentWidth, where, dropped);
    case "table": {
      const t = tableBlockChild(block, o, contentWidth);
      return t ? [t] : [];
    }
  }
}

function contentChildren(report: Report, dropped: DroppedImage[]): Array<Paragraph | Table> {
  const o = report.options;
  const reference = report.cover.style === "reference";
  const contentWidth = reference ? PAGE.width - 3600 : CONTENT_WIDTH_TWIP;
  const headings = computeHeadings(report);
  const kids: Array<Paragraph | Table> = [];

  for (const section of report.sections) {
    // 只有「既没标题也没内容」的空节才整节丢掉；有标题就得导出，否则 Word 里会少掉目录中占号的那一行
    if (!section.title.trim() && !sectionHasContent(section)) continue;

    if (section.title.trim()) {
      const label = `${headings.section(section.id)?.text ?? ""}${section.title.trim()}`;
      kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: label }));
    }

    if (section.mode === "plain") {
      const where = section.title.trim() || "未命名小节";
      for (const b of section.steps[0].blocks) kids.push(...blockChildren(b, o, contentWidth, where, dropped));
      continue;
    }

    for (const step of section.steps) {
      // 与 UI 用同一个判定：不占号的步骤也不导出，编号序列才不会和目录对不上
      if (!countForNumbering(section, step)) continue;
      const where = `${section.title.trim() || "未命名小节"} / ${step.title.trim() || "未命名步骤"}`;
      const body = step.blocks.flatMap((b) => blockChildren(b, o, contentWidth, where, dropped));
      const label = `${headings.step(`${section.id}:${step.id}`)?.text ?? ""}${step.title.trim()}`.trimEnd();
      kids.push(new Paragraph({ heading: HeadingLevel.HEADING_3, text: label }));
      kids.push(...body);
    }
  }
  return kids;
}

/* ---------------- 页脚 ---------------- */

function pageFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "第 ", size: 18, color: SUB_COLOR }),
          new TextRun({ children: [PageNumber.CURRENT], size: 18, color: SUB_COLOR }),
          new TextRun({ text: " 页 / 共 ", size: 18, color: SUB_COLOR }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: SUB_COLOR }),
          new TextRun({ text: " 页", size: 18, color: SUB_COLOR }),
        ],
      }),
    ],
  });
}

/* ---------------- 主入口 ---------------- */

export interface BuiltDocx {
  blob: Blob;
  /** 导出时丢了东西，人话写在这里，界面必须显示出来 */
  warnings: string[];
}

export async function buildReportBlob(report: Report): Promise<BuiltDocx> {
  const o = report.options;
  const reference = report.cover.style === "reference";
  const pageProps = { page: { size: { width: PAGE.width, height: PAGE.height }, margin: reference ? { ...MARGIN, left: 1800, right: 1800 } : MARGIN } };
  const sections: ISectionOptions[] = [];
  const dropped: DroppedImage[] = [];

  if (coverHasOwnPage(report.cover)) {
    // 封面独立成页 → 两个 section，正文从第 1 页开始编号
    const coverKids: Paragraph[] = reference ? referenceCover(report) : heroCover(report);
    sections.push({ properties: pageProps, children: coverKids });
    sections.push({
      properties: { ...pageProps, type: SectionType.NEXT_PAGE, page: { ...pageProps.page, pageNumbers: { start: 1 } } },
      footers: o.pageNumber ? { default: pageFooter() } : undefined,
      children: contentChildren(report, dropped),
    });
  } else {
    const plainKids: Array<Paragraph | Table> = [...plainCover(report)];
    if (o.toc) {
      plainKids.push(new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-3" }));
    }
    sections.push({
      properties: pageProps,
      footers: o.pageNumber ? { default: pageFooter() } : undefined,
      children: [...plainKids, ...contentChildren(report, dropped)],
    });
  }

  if (o.toc && coverHasOwnPage(report.cover)) {
    // 封面另起一页时，目录放在正文 section 的最前面
    const body = sections[1].children as Array<Paragraph | Table>;
    sections[1] = {
      ...sections[1],
      children: [new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-3" }), ...body],
    };
  }

  const doc = new Document({
    creator: report.meta.name || "实验报告向导",
    title: autoTitle(report),
    description: `实验报告：${autoTitle(report)}`,
    styles: buildStyles(o, reference),
    sections,
    features: o.toc ? { updateFields: true } : undefined,
  });

  const blob = await Packer.toBlob(doc);
  return { blob, warnings: droppedImageWarnings(dropped) };
}

/** 图片没进 Word 是唯一「文件生成了但内容少了」的情况，说清楚在哪、剩什么 */
function droppedImageWarnings(dropped: DroppedImage[]): string[] {
  if (!dropped.length) return [];
  const listed = dropped
    .slice(0, 3)
    .map((d) => `${d.where}${d.caption ? `（${d.caption.slice(0, 18)}）` : ""}`)
    .join("、");
  return [
    `${dropped.length} 张图片没能导出：${listed}${dropped.length > 3 ? " 等" : ""}。` +
      "图片数据在本机读不出来了，请回编辑器重贴，或在 Word 里手动插入。",
  ];
}
