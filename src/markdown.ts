import { computeHeadings, type Headings } from "./headings";
import { sectionHasContent, type Block, type Report, type Section, type Step } from "./types";

/** 该报告里第 n 张图（从 1 开始）的默认图注 */
function figureLabel(index: number): string {
  return `图 ${index}`;
}

function fenceFor(code: string): string {
  const m = code.match(/`{3,}/g);
  const longest = m ? Math.max(...m.map((s) => s.length)) : 0;
  return "`".repeat(Math.max(3, longest + 1));
}

function blockToMarkdown(block: Block, figNo: { n: number }): string[] {
  switch (block.kind) {
    case "text": {
      const t = block.text.replace(/\r\n/g, "\n").trim();
      if (!t) return [];
      // 每个换行视为一个独立段落，方便在 Word 里保持原始分行
      return t.split(/\n+/).map((line) => line.trimEnd());
    }
    case "code": {
      const code = block.code.replace(/\r\n/g, "\n").replace(/\s+$/, "");
      if (!code.trim()) return [];
      const fence = fenceFor(code);
      return [`${fence}${block.lang || ""}`, code, fence];
    }
    case "image": {
      if (!block.dataUrl) return [];
      figNo.n += 1;
      const caption = block.caption.trim() || figureLabel(figNo.n);
      const out = [`![${caption}](${block.dataUrl})`, ""];
      if (block.caption.trim()) {
        // pandoc 风格图注：渲染为「图 N 说明文字」
        out.push(`: ${block.caption.trim()} {#fig:img${figNo.n}}`, "");
      }
      return out;
    }
    case "table": {
      const rows = block.rows.filter((r) => r.some((c) => c.trim() !== ""));
      if (rows.length === 0) return [];
      const width = Math.max(...rows.map((r) => r.length));
      const norm = rows.map((r) => {
        const cells = [...r];
        while (cells.length < width) cells.push("");
        return `| ${cells.map((c) => c.replace(/\|/g, "\\|").trim()).join(" | ")} |`;
      });
      const sep = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
      return [norm[0], sep, ...norm.slice(1), ""];
    }
  }
}

function stepBlocksToMarkdown(step: Step, figNo: { n: number }): string[] {
  const lines: string[] = [];
  for (const b of step.blocks) {
    const part = blockToMarkdown(b, figNo);
    if (part.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(...part);
  }
  return lines;
}

function sectionToMarkdown(section: Section, figNo: { n: number }, headings: Headings): string[] {
  const out: string[] = section.title.trim()
    ? [`## ${headings.section(section.id)?.text ?? ""}${section.title.trim()}`, ""]
    : [];
  if (section.mode === "plain") {
    out.push(...stepBlocksToMarkdown(section.steps[0], figNo));
    return out;
  }
  for (const step of section.steps) {
    const label = headings.step(`${section.id}:${step.id}`);
    if (!label) continue;
    const body = stepBlocksToMarkdown(step, figNo);
    out.push(`### ${label.text}${step.title.trim()}`.trimEnd(), "");
    out.push(...body, "");
  }
  return out;
}

/** 把整份报告序列化成 Markdown —— 这就是「转换按钮」的中间产物 */
export function reportToMarkdown(report: Report): string {
  const { meta, sections } = report;
  const head = [`# 实验${meta.order}${meta.topic ? `：${meta.topic}` : ""}`];
  const metaLine = [
    meta.studentId ? `学号：${meta.studentId}` : "",
    meta.name ? `姓名：${meta.name}` : "",
    meta.date ? `日期：${meta.date}` : "",
  ]
    .filter(Boolean)
    .join("　");
  if (metaLine) head.push("", metaLine);

  const figNo = { n: 0 };
  const headings = computeHeadings(report);
  const body: string[] = [];
  for (const s of sections) {
    // 与 docx/build.ts 同一个判定：整节没标题也没内容才丢掉
    if (!s.title.trim() && !sectionHasContent(s)) continue;
    const part = sectionToMarkdown(s, figNo, headings);
    if (part.length === 0) continue;
    body.push(...part, "");
  }

  return [...head, "", ...body].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function reportFileName(report: Report): string {
  const values: Record<string, string> = {
    order: report.meta.order,
    studentId: report.meta.studentId,
    name: report.meta.name,
    topic: report.meta.topic,
    title: report.cover.title.trim() || report.meta.topic,
    date: report.meta.date,
  };
  const pattern = report.options.fileNamePattern.trim() || "实验{order}_{studentId}_{name}_{topic}";
  const rendered = pattern.replace(/\{(order|studentId|name|topic|title|date)\}/g, (_, key: string) => values[key] ?? "");
  const cleaned = rendered
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[_\s-]{2,}/g, "_")
    .replace(/^[_\s-]+|[_\s-]+$/g, "")
    .trim();
  return `${cleaned || `实验${report.meta.order || "报告"}`}.docx`;
}
