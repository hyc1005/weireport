import { sectionHasContent, stepHasContent, type Report, type Section, type Step } from "./types";
import { autoTitle, coverHasOwnPage } from "./cover";
import { computeHeadings } from "./headings";

export type Page =
  | {
      kind: "cover";
      key: "cover";
      label: string;
      filled: boolean;
    }
  | {
      kind: "content";
      key: string;
      label: string;
      filled: boolean;
      sectionId: string;
      stepId: string;
      section: Section;
      step: Step;
      stepIndex: number;
      stepCount: number;
    };

export const COVER_PAGE_KEY = "cover";

/** 把工程拍平成「向导页」：第 1 页恒为封面设置，之后 plain 小节 1 页、steps 小节每步 1 页 */
export function flattenPages(report: Report): Page[] {
  const headings = computeHeadings(report);
  const pages: Page[] = [
    {
      kind: "cover",
      key: COVER_PAGE_KEY,
      label: `封面（${autoTitle(report)}）`,
      filled: !coverHasOwnPage(report.cover) || autoTitle(report).length > 0,
    },
  ];

  for (const section of report.sections) {
    const sectionLabel = `${headings.section(section.id)?.text ?? ""}${section.title}`;
    if (section.mode === "plain") {
      const step = section.steps[0];
      pages.push({
        kind: "content",
        key: `${section.id}:${step.id}`,
        label: sectionLabel,
        filled: stepHasContent(step),
        sectionId: section.id,
        stepId: step.id,
        section,
        step,
        stepIndex: 0,
        stepCount: 1,
      });
      continue;
    }
    section.steps.forEach((step, i) => {
      pages.push({
        kind: "content",
        key: `${section.id}:${step.id}`,
        label: `${sectionLabel} · ${headings.step(`${section.id}:${step.id}`)?.text ?? ""}${step.title.trim() || "未命名步骤"}`,
        filled: stepHasContent(step),
        sectionId: section.id,
        stepId: step.id,
        section,
        step,
        stepIndex: i,
        stepCount: section.steps.length,
      });
    });
  }
  return pages;
}

export function projectProgress(report: Report): { done: number; total: number } {
  const total = report.sections.reduce(
    (n, s) => n + (s.mode === "steps" ? s.steps.length : 1),
    0,
  );
  const done = report.sections.reduce(
    (n, s) =>
      n +
      (s.mode === "steps"
        ? s.steps.filter(stepHasContent).length
        : sectionHasContent(s)
          ? 1
          : 0),
    0,
  );
  return { done, total };
}

/* ---------------- 截止日期反推 ---------------- */

export interface DeadlinePlan {
  /** 还剩几天：0 = 今天到期，负数 = 已过期 */
  daysLeft: number;
  remaining: number;
  /** 每天写几步才来得及；已过期时为 0 */
  perDay: number;
}

/** 只认 YYYY-MM-DD（date 输入框的格式）；没填或填坏返回 null，界面就不显示倒计时 */
export function planDeadline(due: string, remaining: number, today = new Date()): DeadlinePlan | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(due.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dueDay = Date.UTC(y, mo - 1, d);
  const back = new Date(dueDay);
  // 「2026-13-45」这类会被 Date.UTC 悄悄进位到别的日子，宁可当没填
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const daysLeft = Math.round((dueDay - todayDay) / 86400000);
  const left = Math.max(Math.round(remaining), 0);
  return { daysLeft, remaining: left, perDay: daysLeft > 0 ? Math.ceil(left / daysLeft) : left };
}

export function deadlineLabel(plan: DeadlinePlan): string {
  const { daysLeft, remaining } = plan;
  if (!remaining) return daysLeft < 0 ? `截止日已过 ${-daysLeft} 天 · 内容已填满` : `还剩 ${daysLeft} 天 · 内容已填满`;
  if (daysLeft < 0) return `已逾期 ${-daysLeft} 天 · 还差 ${remaining} 项没写`;
  if (daysLeft === 0) return `今天到期 · 还差 ${remaining} 项没写`;
  if (daysLeft === 1) return `明天到期 · 今天写完这 ${remaining} 项`;
  return `剩 ${daysLeft} 天 · 还差 ${remaining} 项 → 每天 ${plan.perDay} 项`;
}

/** 首页卡片上的短版本 */
export function deadlineChip(plan: DeadlinePlan): string {
  if (plan.daysLeft < 0) return `逾期 ${-plan.daysLeft} 天`;
  if (plan.daysLeft === 0) return "今天到期";
  if (plan.daysLeft === 1) return "明天到期";
  return `剩 ${plan.daysLeft} 天`;
}

export function deadlineTone(plan: DeadlinePlan): "calm" | "warn" | "danger" {
  if (plan.daysLeft <= 0 && plan.remaining > 0) return "danger";
  if (plan.remaining > 0 && plan.daysLeft <= 2) return "warn";
  return "calm";
}
