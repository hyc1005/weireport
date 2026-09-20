/**
 * 截取当前窗口 / 屏幕 + 图片压缩
 *
 * 压缩很关键：原来的截图是 2~4 MB 的 PNG，直接用会把存储和 docx 都撑爆。
 * 这里统一走「限宽 → WebP q0.9 → 仍超标就降质量/再缩」的流程，单张目标 ≤400KB。
 */

import { dataUrlBytes as measureBytes } from "./base64";

export type CaptureTarget = "window" | "screen";

/** 一张图：dataURL + 实际像素尺寸（导出时用来算宽高比） */
export interface CapturedImage {
  dataUrl: string;
  w: number;
  h: number;
  bytes: number;
  mime: string;
}

export interface CompressOptions {
  /** 最长边上限，默认 1400px */
  maxWidth?: number;
  /** 目标字节数，默认 400KB */
  targetBytes?: number;
  /** 起始质量，默认 0.9 */
  quality?: number;
}

const DEFAULTS: Required<CompressOptions> = {
  maxWidth: 1400,
  targetBytes: 400 * 1024,
  quality: 0.9,
};

/** 单张超过这个大小就在界面上提醒 */
export const IMAGE_WARN_BYTES = 800 * 1024;

export function isCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function"
  );
}

/** 弹一次系统选择框（窗口/屏幕/标签页），抓到一帧后立刻关闭共享 */
export async function captureOnce(target: CaptureTarget = "window"): Promise<CapturedImage> {
  if (!isCaptureSupported()) {
    throw new Error("当前浏览器不支持屏幕捕获（请用 Chrome / Edge，并通过 localhost 或 https 访问）");
  }
  const constraints: DisplayMediaStreamOptions = {
    video: { displaySurface: target, frameRate: 30 } as MediaTrackConstraints,
    audio: false,
  };

  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("等待画面超时")), 8000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("读取画面失败"));
      };
    });

    await video.play();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new Error("捕获到的画面尺寸为 0");

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 canvas 上下文");
    ctx.drawImage(video, 0, 0, w, h);
    return await compressImage(canvas.toDataURL("image/png"));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/* ---------------- 压缩 ---------------- */

export async function compressImage(
  source: Blob | string,
  options: CompressOptions = {},
): Promise<CapturedImage> {
  const opts = { ...DEFAULTS, ...options };
  const original = typeof source === "string" ? source : await blobToDataUrl(source);
  const img = await loadImage(original);

  const srcW = img.naturalWidth || 1;
  const srcH = img.naturalHeight || 1;
  const scaleLimit = Math.min(1, opts.maxWidth / Math.max(srcW, srcH));

  let scale = scaleLimit;
  let quality = opts.quality;
  let best: { dataUrl: string; mime: string; bytes: number; w: number; h: number } | null = null;

  for (let round = 0; round < 5; round += 1) {
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);

    const candidate = pickSmallest(canvas, quality);
    if (!best || candidate.bytes < best.bytes) best = { ...candidate, w, h };
    if (candidate.bytes <= opts.targetBytes) {
      best = { ...candidate, w, h };
      break;
    }
    // 还超标：先降质量，质量见底了再缩尺寸
    if (quality > 0.55) quality = Math.max(0.55, quality - 0.12);
    else if (scale > 0.4) scale *= 0.85;
    else break;
  }

  if (!best) {
    const bytes = measureBytes(original);
    return { dataUrl: original, w: srcW, h: srcH, bytes, mime: mimeOf(original) };
  }
  return { dataUrl: best.dataUrl, w: best.w, h: best.h, bytes: best.bytes, mime: best.mime };
}

/** WebP 通常比 PNG 小一个量级；但纯色/线条图偶尔 PNG 更小，所以两个都算，取小的 */
function pickSmallest(canvas: HTMLCanvasElement, quality: number) {
  const webp = canvas.toDataURL("image/webp", quality);
  const candidates: Array<{ dataUrl: string; mime: string }> = [];
  if (webp.startsWith("data:image/webp")) {
    candidates.push({ dataUrl: webp, mime: "image/webp" });
  } else {
    // 浏览器不支持 WebP → 退 JPEG（有损但体积可控）
    const jpeg = canvas.toDataURL("image/jpeg", quality);
    if (jpeg.startsWith("data:image/jpeg")) candidates.push({ dataUrl: jpeg, mime: "image/jpeg" });
  }
  candidates.push({ dataUrl: canvas.toDataURL("image/png"), mime: "image/png" });

  let best = candidates[0];
  let bestBytes = measureBytes(best.dataUrl);
  for (const c of candidates.slice(1)) {
    const bytes = measureBytes(c.dataUrl);
    if (bytes < bestBytes) {
      best = c;
      bestBytes = bytes;
    }
  }
  return { ...best, bytes: bestBytes };
}

export function mimeOf(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl);
  return m ? m[1] : "";
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("读取图片失败"));
    fr.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = src;
  });
}

/* ---------------- 展示用工具 ---------------- */

export function estimateDataUrlBytes(dataUrl: string): number {
  return measureBytes(dataUrl);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
