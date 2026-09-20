/**
 * 导入清单 → 工程
 *   parse.ts 只负责「读出一行一行 + 建议等级」，这里是把确认过的等级拼成可编辑工程。
 *   两件硬要求：
 *     · 连续正文段落合并成一个多行文字块（每块上限 30 行），否则一条 20 项的清单会变成 20 个块；
 *     · 标题的手写编号在预览阶段就被剥进结构里，这里只写干净的标题，序号由系统按设置重新生成。
 *   图片走 prepareImage 钩子：浏览器传 compressImage 进来（WebP ≤400KB），
 *   node 自检不传，原样入库 —— 这样解析层不需要 canvas。
 */
import { createReport } from "./template";
import { levelOfItem, type ImportImage, type ImportParse, type ItemLevel } from "./docx/parse";
import { imageBlock, textBlock, uid, type Report, type Section, type Step } from "./types";

/** 一个文字块最多收多少行，超了就另起一块 */
export const MAX_LINES_PER_BLOCK = 30;

/** 上层压一张图；返回 null 表示这张压不动（浏览器解不了），导入时丢掉 */
export type PrepareImage = (image: ImportImage) => Promise<{ dataUrl: string; w: number; h: number } | null>;

/**
 * 浏览器侧用的预处理钩子：字节交给 compress（压成 WebP），尺寸另说。
 * 显示尺寸必须沿用 Word 里排好的那个（wp:extent 换算来的 px）——
 * 压缩后的像素数跟作者在 Word 里给的排版宽度没关系，用 shot 的宽度等于把排版丢了。
 */
export function makeImagePreparer(
  compress: (dataUrl: string) => Promise<{ dataUrl: string; w: number; h: number }>,
  onUndecodable: () => void,
): PrepareImage {
  return async (image) => {
    try {
      const shot = await compress(image.dataUrl);
      return { dataUrl: shot.dataUrl, w: image.w || shot.w, h: image.h || shot.h };
    } catch {
      // 浏览器解不了这张（Word 里塞了奇怪的位图）：丢掉它，别把整份导入带回失败
      onUndecodable();
      return null;
    }
  };
}

export async function buildReportFromItems(
  parsed: ImportParse,
  overrides: Map<number, ItemLevel>,
  fileName: string,
  prepareImage?: PrepareImage,
): Promise<Report> {
  const sections: Section[] = [];
  let section: Section | null = null;
  let step: Step | null = null;
  let pending: string[] = [];

  const ensureSection = (): Section => {
    if (!section) {
      section = { id: uid("sec"), title: "导入内容", mode: "steps", required: false, steps: [] };
      sections.push(section);
      step = null;
    }
    return section;
  };

  const ensureStep = (): Step => {
    const s = ensureSection();
    if (!step) {
      step = { id: uid("s"), title: "", blocks: [] };
      s.steps.push(step);
    }
    return step;
  };

  const flushText = () => {
    if (!pending.length) return;
    const target = ensureStep();
    for (let i = 0; i < pending.length; i += MAX_LINES_PER_BLOCK) {
      target.blocks.push(textBlock(pending.slice(i, i + MAX_LINES_PER_BLOCK).join("\n")));
    }
    pending = [];
  };

  const openSection = (title: string) => {
    flushText();
    section = { id: uid("sec"), title, mode: "steps", required: false, steps: [] };
    sections.push(section);
    step = null;
  };

  const openStep = (title: string) => {
    flushText();
    const s = ensureSection();
    step = { id: uid("s"), title, blocks: [] };
    s.steps.push(step);
  };

  for (const item of parsed.items) {
    const level = levelOfItem(overrides, item);
    if (level === "ignore") continue;
    if (item.kind === "image") {
      if (!item.image) continue;
      const prepared = prepareImage ? await prepareImage(item.image) : item.image;
      if (!prepared) continue;
      flushText();
      const target = ensureStep();
      target.blocks.push(imageBlock(prepared.dataUrl, prepared.w, prepared.h));
      continue;
    }
    if (item.kind === "table") {
      flushText();
      const target = ensureStep();
      target.blocks.push({ id: uid("b"), kind: "table", headerRow: true, rows: item.rows ?? [] });
      continue;
    }
    const text = item.text.trim();
    if (!text) continue;
    if (level === "section") openSection(text);
    else if (level === "step") openStep(text);
    else pending.push(text);
  }
  flushText();

  for (const s of sections) if (!s.steps.length) s.steps.push({ id: uid("s"), title: "", blocks: [] });
  if (!sections.length) {
    sections.push({ id: uid("sec"), title: "导入内容", mode: "steps", required: false, steps: [{ id: uid("s"), title: "", blocks: [] }] });
  }

  const title = parsed.docTitle || fileName.replace(/\.docx$/i, "");
  const base = createReport({ name: `导入 · ${title}`, order: "" }, sections);
  base.cover.style = "plain";
  base.cover.title = title;
  base.cover.subtitle = "从 Word 导入";
  base.meta.topic = title;
  return base;
}

/** 什么都不猜：全部当正文，一个「导入内容」小节到底。解析失败时的兜底。 */
export function plainTextOverrides(parsed: ImportParse): Map<number, ItemLevel> {
  const map = new Map<number, ItemLevel>();
  for (const item of parsed.items) map.set(item.index, "body");
  return map;
}
