import { emptyBlock, newStep, uid, type Block, type BlockKind, type Cover, type Report, type ReportOptions, type Section, type Step } from "./types";

/* 对工程树做不可变更新的纯函数，避免在组件里写嵌套 map */

/** 只遍历所有块并替换（不动小节/步骤结构），存储与导出都会用到 */
export function mapBlocks(report: Report, fn: (b: Block) => Block): Report {
  return {
    ...report,
    sections: report.sections.map((s) => ({
      ...s,
      steps: s.steps.map((st) => ({ ...st, blocks: st.blocks.map(fn) })),
    })),
  };
}

export function updateMeta(report: Report, patch: Partial<Report["meta"]>): Report {
  return { ...report, meta: { ...report.meta, ...patch } };
}

export function renameProject(report: Report, name: string): Report {
  return { ...report, name };
}

export function updateOptions(report: Report, patch: Partial<ReportOptions>): Report {
  return { ...report, options: { ...report.options, ...patch } };
}

export function updateCover(report: Report, patch: Partial<Cover>): Report {
  return { ...report, cover: { ...report.cover, ...patch } };
}

/* ---------------- 小节 / 步骤 / 块 ---------------- */

export function mapSection(report: Report, sectionId: string, fn: (s: Section) => Section): Report {
  return { ...report, sections: report.sections.map((s) => (s.id === sectionId ? fn(s) : s)) };
}

export function mapStep(report: Report, sectionId: string, stepId: string, fn: (st: Step) => Step): Report {
  return mapSection(report, sectionId, (s) => ({
    ...s,
    steps: s.steps.map((st) => (st.id === stepId ? fn(st) : st)),
  }));
}

export function addBlock(report: Report, sectionId: string, stepId: string, kind: BlockKind): { report: Report; blockId: string } {
  const block = emptyBlock(kind);
  return {
    report: mapStep(report, sectionId, stepId, (st) => ({ ...st, blocks: [...st.blocks, block] })),
    blockId: block.id,
  };
}

/**
 * 插入一个已有的块。`index` 不给就追加到末尾；给了就插到那个位置（越界自动收边）。
 * 粘贴 / 截图 / 剪贴板都走这里，位置算法只有一份。
 */
export function insertBlock(
  report: Report,
  sectionId: string,
  stepId: string,
  block: Block,
  index?: number,
): { report: Report; blockId: string } {
  return {
    report: mapStep(report, sectionId, stepId, (st) => {
      const blocks = [...st.blocks];
      blocks.splice(index === undefined ? blocks.length : Math.max(0, Math.min(index, blocks.length)), 0, block);
      return { ...st, blocks };
    }),
    blockId: block.id,
  };
}

/**
 * 「插在选中块之后」的位置算法，粘贴 / 截图 / ＋插入 三处共用一份。
 * 没选中（或选中的块已不在这一页）返回 `undefined` = 追加到末尾。
 */
export function afterBlock(blocks: Block[], blockId: string | null): number | undefined {
  if (!blockId) return undefined;
  const i = blocks.findIndex((b) => b.id === blockId);
  return i >= 0 ? i + 1 : undefined;
}

export function insertBlockAt(report: Report, sectionId: string, stepId: string, index: number, kind: BlockKind): { report: Report; blockId: string } {
  const block = emptyBlock(kind);
  return { report: mapStep(report, sectionId, stepId, (st) => { const blocks = [...st.blocks]; blocks.splice(Math.max(0, Math.min(index, blocks.length)), 0, block); return { ...st, blocks }; }), blockId: block.id };
}

export function updateBlock(report: Report, sectionId: string, stepId: string, blockId: string, patch: Partial<Block>): Report {
  return mapStep(report, sectionId, stepId, (st) => ({
    ...st,
    blocks: st.blocks.map((b) => (b.id === blockId ? ({ ...b, ...patch } as Block) : b)),
  }));
}

export function removeBlock(report: Report, sectionId: string, stepId: string, blockId: string): Report {
  return mapStep(report, sectionId, stepId, (st) => ({ ...st, blocks: st.blocks.filter((b) => b.id !== blockId) }));
}

export function moveBlock(report: Report, sectionId: string, stepId: string, blockId: string, delta: -1 | 1): Report {
  return mapStep(report, sectionId, stepId, (st) => {
    const i = st.blocks.findIndex((b) => b.id === blockId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= st.blocks.length) return st;
    const blocks = [...st.blocks];
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    return { ...st, blocks };
  });
}

export function updateStepTitle(report: Report, sectionId: string, stepId: string, title: string): Report {
  return mapStep(report, sectionId, stepId, (st) => ({ ...st, title }));
}

export function addStep(report: Report, sectionId: string): { report: Report; stepId: string } {
  const step = newStep();
  return {
    report: mapSection(report, sectionId, (s) => ({ ...s, steps: [...s.steps, step] })),
    stepId: step.id,
  };
}

export function removeStep(report: Report, sectionId: string, stepId: string): Report {
  return mapSection(report, sectionId, (s) => {
    if (s.steps.length <= 1) return s;
    return { ...s, steps: s.steps.filter((st) => st.id !== stepId) };
  });
}

export function moveStep(report: Report, sectionId: string, stepId: string, delta: -1 | 1): Report {
  return mapSection(report, sectionId, (s) => {
    const i = s.steps.findIndex((st) => st.id === stepId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= s.steps.length) return s;
    const steps = [...s.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    return { ...s, steps };
  });
}

export function updateSectionTitle(report: Report, sectionId: string, title: string): Report {
  return mapSection(report, sectionId, (s) => ({ ...s, title }));
}

export function setSectionMode(report: Report, sectionId: string, mode: Section["mode"]): Report {
  return mapSection(report, sectionId, (s) => {
    if (s.mode === mode) return s;
    if (mode === "plain") {
      // 合并所有步骤的块到第一个步骤
      const blocks = s.steps.flatMap((st) => st.blocks);
      return { ...s, mode, steps: [{ id: s.steps[0].id, title: "", blocks }] };
    }
    return { ...s, mode, steps: s.steps.length ? s.steps : [newStep()] };
  });
}

export function addSection(report: Report, title = "新小节"): { report: Report; sectionId: string } {
  const section: Section = {
    id: uid("sec"),
    title,
    mode: "plain",
    required: false,
    steps: [{ id: uid("s"), title: "", blocks: [emptyBlock("text")] }],
  };
  return { report: { ...report, sections: [...report.sections, section] }, sectionId: section.id };
}

export function removeSection(report: Report, sectionId: string): Report {
  if (report.sections.length <= 1) return report;
  return { ...report, sections: report.sections.filter((s) => s.id !== sectionId) };
}

export function moveSection(report: Report, sectionId: string, delta: -1 | 1): Report {
  const i = report.sections.findIndex((s) => s.id === sectionId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= report.sections.length) return report;
  const sections = [...report.sections];
  [sections[i], sections[j]] = [sections[j], sections[i]];
  return { ...report, sections };
}
