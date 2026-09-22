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
  stepRestart: "document",
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

/** 新建一个工程；想复用旧骨架时把 sections 传进来即可 */
export function createReport(input: CreateReportInput = {}, sections?: Section[]): Report {
  const now = Date.now();
  const order = input.order ?? "01";
  const topic = input.topic ?? "";
  return {
    id: uid("proj"),
    name: input.name ?? `实验${order}${topic ? ` ${topic}` : ""}`,
    createdAt: now,
    updatedAt: now,
    meta: {
      order,
      topic,
      studentId: input.studentId ?? "",
      name: input.name_ ?? "",
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
