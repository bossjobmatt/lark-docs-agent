/** 图片附件：粘贴/选择 → 校验与降采样 → 预览条；发送时由 chat.js 取走并清空 */
import { dataUrl } from "./ui.js";

const MAX_IMAGES = 3;
const MAX_BYTES = 4 * 1024 * 1024; // 与服务端 IMAGE_MAX_KB 默认值一致，服务端为最终权威
const MAX_EDGE = 2000; // 超过该边长降采样为 JPEG，控制 base64 体积与视觉 token 成本
const MIME_OK = new Set(["image/png", "image/jpeg", "image/webp"]);

const input = document.getElementById("input");
const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("attach-file");
const strip = document.getElementById("attach-strip");

let attachments = []; // { mime, data(base64 裸串), name, url(预览用 dataURL) }

export function count() {
  return attachments.length;
}

/** 取走全部附件（发送后调用）：返回 { mime, data, name }[] 并清空预览 */
export function take() {
  const out = attachments.map(({ mime, data, name }) => ({ mime, data, name }));
  clear();
  return out;
}

export function clear() {
  attachments = [];
  render();
}

/** 加载图片元素；失败返回 null */
function loadImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** FileReader 读文件为 base64 裸串 */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("读取图片失败"));
    r.readAsDataURL(file);
  });
}

/** 处理单个图片文件：数量/格式校验 → 超长边经 canvas 缩小并转 JPEG → 大小校验 → 入列 */
async function addFile(file, idx) {
  if (attachments.length >= MAX_IMAGES) return alert(`图片最多 ${MAX_IMAGES} 张`);
  if (!MIME_OK.has(file.type)) return alert(`第 ${idx} 张图片格式不支持（仅支持 PNG / JPEG / WebP）`);
  let blob = file;
  let mime = file.type;
  let name = file.name || "图片";

  const loaded = await loadImage(file);
  if (loaded) {
    const edge = Math.max(loaded.img.width, loaded.img.height);
    if (edge > MAX_EDGE) {
      const scale = MAX_EDGE / edge;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(loaded.img.width * scale);
      canvas.height = Math.round(loaded.img.height * scale);
      canvas.getContext("2d").drawImage(loaded.img, 0, 0, canvas.width, canvas.height);
      const scaled = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (scaled) {
        blob = scaled;
        mime = "image/jpeg";
        name = name.replace(/\.[a-z0-9]+$/i, "") + ".jpg";
      }
    }
    URL.revokeObjectURL(loaded.url);
  }

  if (blob.size > MAX_BYTES) return alert(`第 ${idx} 张图片超过 4MB 上限，请裁剪后重试`);
  try {
    const data = await readAsBase64(blob);
    if (!data) return alert(`第 ${idx} 张图片读取失败`);
    attachments.push({ mime, data, name, url: dataUrl({ mime, data }) });
    render();
  } catch {
    alert(`第 ${idx} 张图片读取失败`);
  }
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  for (let i = 0; i < list.length; i++) await addFile(list[i], i + 1);
}

function render() {
  strip.innerHTML = "";
  strip.classList.toggle("hidden", !attachments.length);
  for (const [i, a] of attachments.entries()) {
    const item = document.createElement("div");
    item.className = "attach-thumb";
    const img = document.createElement("img");
    img.src = a.url;
    img.alt = a.name;
    const del = document.createElement("button");
    del.type = "button";
    del.title = "移除图片";
    del.textContent = "×";
    del.addEventListener("click", () => {
      attachments.splice(i, 1);
      render();
    });
    item.appendChild(img);
    item.appendChild(del);
    strip.appendChild(item);
  }
}

// ---------- 入口事件：按钮选择 / 输入框粘贴 ----------
attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = ""; // 允许重复选择同一文件
});

input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault(); // 阻止把图片当文本塞进输入框
    addFiles(files);
  }
});
