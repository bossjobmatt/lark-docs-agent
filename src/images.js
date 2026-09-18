/**
 * 图片附件校验与归一化：供 /api/chat 与 /api/chat/stream 使用。
 * 前端提交 { mime, data(base64), name? } 数组；这里做 mime 白名单、数量与解码后大小上限校验，
 * 非法输入抛错（消息面向用户，由路由层转为 400）。
 */
const MAX_IMAGES = 3; // 与单条消息文档数上限一致
// 单张解码后大小上限；显式 0 一律生效 = 禁用图片上传（与仓库「显式 0 生效」惯例一致），负数/非法值回落默认
const MAX_KB = Number.isFinite(Number(process.env.IMAGE_MAX_KB)) ? Number(process.env.IMAGE_MAX_KB) : 4096;
const MIME_WHITELIST = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const IMAGE_PROMPT = "请分析这些图片"; // 纯图片无文本时的统一引导语（内置编排与 pi 模式共用）

/** 请求体上限：base64 膨胀约 4/3，再留 JSON 与文本余量 */
function bodyLimit() {
  return MAX_IMAGES * MAX_KB * 1024 * 2 + 1024 * 1024;
}

/** 归一化图片数组；非法输入抛错，合法输入返回 { mime, data, name? }[] */
function normalizeImages(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("images 必须是数组");
  if (raw.length > MAX_IMAGES) throw new Error(`图片最多 ${MAX_IMAGES} 张`);
  return raw.map((im, i) => {
    const mime = im && im.mime;
    if (!MIME_WHITELIST[mime]) throw new Error(`第 ${i + 1} 张图片格式不支持（仅支持 PNG / JPEG / WebP）`);
    const data = String((im && im.data) || "").replace(/\s+/g, "");
    if (!data) throw new Error(`第 ${i + 1} 张图片数据为空`);
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error(`第 ${i + 1} 张图片数据非法`);
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) throw new Error(`第 ${i + 1} 张图片数据无效`);
    if (bytes.length > MAX_KB * 1024) throw new Error(`第 ${i + 1} 张图片超过 ${MAX_KB}KB 上限`);
    const out = { mime, data };
    if (im.name) out.name = String(im.name).slice(0, 80);
    return out;
  });
}

/** OpenAI 多模态 user content：带图片时返回 content 数组（图片块在前），否则回落纯文本 */
function toUserContent(text, images) {
  if (!images || !images.length) return text;
  return [
    ...images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } })),
    { type: "text", text: text || IMAGE_PROMPT },
  ];
}

module.exports = { normalizeImages, bodyLimit, toUserContent, IMAGE_PROMPT, MAX_IMAGES, MAX_KB };
