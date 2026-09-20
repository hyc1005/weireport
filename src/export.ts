import { reportFileName, reportToMarkdown } from "./markdown";
import type { Report } from "./types";

export interface ExportResult {
  blob: Blob;
  fileName: string;
  /** 文件生成了但内容有缺失（图片读不出来），调用方要显示给用户 */
  warnings: string[];
}

/** 工程 → docx（浏览器本地生成，不联网）。docx 库按需加载，不拖慢首屏 */
export async function buildDocx(report: Report): Promise<ExportResult> {
  const [{ buildReportBlob }, { prepareReportForDocx }] = await Promise.all([
    import("./docx/build"),
    import("./docx/prepare"),
  ]);
  // 库里存的是 WebP 截图（体积小），Word 不认，先转成 png/jpeg
  const ready = await prepareReportForDocx(report);
  const { blob, warnings } = await buildReportBlob(ready);
  return { blob, fileName: reportFileName(report), warnings };
}

export async function downloadReport(report: Report): Promise<ExportResult> {
  const result = await buildDocx(report);
  downloadBlob(result.blob, result.fileName);
  return result;
}

export function downloadMarkdown(report: Report): string {
  const fileName = reportFileName(report).replace(/\.docx$/, ".md");
  const blob = new Blob([reportToMarkdown(report)], { type: "text/markdown;charset=utf-8" });
  downloadBlob(blob, fileName);
  return fileName;
}

export function downloadJson(text: string, fileName: string): void {
  downloadBlob(new Blob([text], { type: "application/json;charset=utf-8" }), fileName);
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
