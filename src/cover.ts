import type { Cover, CoverStyle, Report } from "./types";

export const COVER_STYLES: Array<{ value: CoverStyle; label: string; desc: string }> = [
  { value: "reference", label: "课程报告", desc: "独立大字封面，宽页边距（默认）" },
  {
    value: "hero",
    label: "正式风",
    desc: "独立封面页，大标题居中 + 学号姓名日期",
  },
  {
    value: "plain",
    label: "简洁风",
    desc: "不占独立页，标题接着正文，适合短报告",
  },
];

export function coverStyleLabel(style: CoverStyle): string {
  return COVER_STYLES.find((s) => s.value === style)?.label ?? style;
}

/** 大标题：封面自定义标题优先，否则用「实验N：主题」 */
export function autoTitle(report: Report): string {
  if (report.cover.title.trim()) return report.cover.title.trim();
  const { order, topic } = report.meta;
  return `实验${order}${topic ? `：${topic}` : ""}`;
}

export function metaLine(report: Report): string {
  const { studentId, name, date } = report.meta;
  return [
    studentId ? `学号：${studentId}` : "",
    name ? `姓名：${name}` : "",
    date ? `日期：${date}` : "",
  ]
    .filter(Boolean)
    .join("　　");
}

/** 封面是否需要独立成页 */
export function coverHasOwnPage(cover: Cover): boolean {
  return cover.style !== "plain";
}
