import { CoverPreview } from "./CoverPanel";
import { computeHeadings } from "../headings";
import type { Block, Report } from "../types";
import { sectionHasContent } from "../types";

function BlockView({ block }: { block: Block }) {
  if (block.kind === "text") return <p className="print-text">{block.text}</p>;
  if (block.kind === "code") return <pre className="print-code">{block.code}</pre>;
  if (block.kind === "image") return block.dataUrl ? <figure><img src={block.dataUrl} alt={block.caption || "报告插图"} />{block.caption && <figcaption>{block.caption}</figcaption>}</figure> : null;
  const rows = block.rows.filter((r) => r.some((c) => c.trim()));
  return rows.length ? <table className="print-table"><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => i === 0 && block.headerRow ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>)}</tr>)}</tbody></table> : null;
}

export function PrintDocument({ report }: { report: Report }) {
  const headings = computeHeadings(report);
  return <div className="print-document">
    <div className="paper print-paper print-cover"><CoverPreview report={report} /></div>
    {report.sections.filter((s) => s.title.trim() || sectionHasContent(s)).map((section) => <div className="paper print-paper" key={section.id}>
      <h2 data-no={headings.section(section.id)?.no ?? ""}>{headings.section(section.id)?.text ?? ""}{section.title}</h2>
      {section.mode === "plain" ? section.steps[0].blocks.map((b) => <BlockView key={b.id} block={b} />) : section.steps.map((step) => { const label = headings.step(`${section.id}:${step.id}`); return <section key={step.id}><h3 data-no={label?.no ?? ""}>{label?.text ?? ""}{step.title}</h3>{step.blocks.map((b) => <BlockView key={b.id} block={b} />)}</section>; })}
    </div>)}
  </div>;
}
