/**
 * 导出前处理：Word 只认 png / jpeg / gif / bmp，
 * 而库里存的截图是 WebP（体积小得多），所以在生成 docx 之前先转一遍。
 *
 * 转换规则：解出像素后，PNG 与 JPEG(q=0.9) 各编码一次，取更小的那个 ——
 * 代码截图/地图这种大色块 PNG 更小，照片类 JPEG 更小。
 */
import { mimeOf } from "../capture";
import { mapBlocks } from "../reportOps";
import type { Report } from "../types";

const WORD_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/bmp"]);

export async function prepareReportForDocx(report: Report): Promise<Report> {
  const cache = new Map<string, string>();
  const converted = new Map<string, string>();

  for (const block of imageBlocks(report)) {
    const mime = mimeOf(block.dataUrl);
    if (!mime || WORD_MIMES.has(mime)) continue;
    const hit = cache.get(block.dataUrl);
    if (hit) {
      converted.set(block.id, hit);
      continue;
    }
    try {
      const png = await encodeSmallest(block.dataUrl);
      cache.set(block.dataUrl, png);
      converted.set(block.id, png);
    } catch {
      // 转不了就让 build 那层按"无法显示"处理，别把整份导出搞挂
    }
  }

  if (converted.size === 0) return report;
  return mapBlocks(report, (b) => (b.kind === "image" && converted.has(b.id) ? { ...b, dataUrl: converted.get(b.id)! } : b));
}

function imageBlocks(report: Report) {
  const out: Array<Extract<Report["sections"][number]["steps"][number]["blocks"][number], { kind: "image" }>> = [];
  report.sections.forEach((s) =>
    s.steps.forEach((st) =>
      st.blocks.forEach((b) => {
        if (b.kind === "image" && b.dataUrl) out.push(b);
      }),
    ),
  );
  return out;
}

async function encodeSmallest(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1;
  canvas.height = img.naturalHeight || 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0);

  const png = canvas.toDataURL("image/png");
  const jpeg = canvas.toDataURL("image/jpeg", 0.9);
  if (!jpeg.startsWith("data:image/jpeg")) return png;
  return jpeg.length < png.length ? jpeg : png;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = src;
  });
}
