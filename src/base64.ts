/**
 * dataURL ↔ 二进制互转
 *   不依赖 FileReader / fetch / document，Node 里也能跑（离线测试要用）
 */

export interface DecodedImage {
  mime: string;
  bytes: Uint8Array;
}

const DATA_URL_RE = /^data:([^;,]+)(;base64)?,([\s\S]*)$/;

export function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

export function decodeDataUrl(dataUrl: string): DecodedImage | null {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  const mime = m[1];
  const isBase64 = m[2] === ";base64";
  const payload = m[3];
  try {
    if (isBase64) {
      const bin = atob(payload.replace(/\s/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return { mime, bytes };
    }
    const text = decodeURIComponent(payload);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
    return { mime, bytes };
  } catch {
    return null;
  }
}

export function encodeDataUrl(mime: string, bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/** base64 长度反推字节数：不必 atob 解整个数组，只要知道原图多大 */
export function dataUrlBytes(dataUrl: string): number {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return 0;
  if (m[2] === ";base64") {
    const payload = m[3].replace(/\s/g, "");
    if (payload.length % 4 !== 0) return decodeDataUrl(dataUrl)?.bytes.length ?? 0;
    const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return (payload.length / 4) * 3 - pad;
  }
  try {
    return decodeURIComponent(m[3]).length;
  } catch {
    return 0;
  }
}

/** 内容寻址用的短哈希（双通道 FNV-1a + 长度，图片去重足够） */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${input.length.toString(36)}`;
}
