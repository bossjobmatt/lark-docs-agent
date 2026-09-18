/** 欢迎态布局：新会话（无消息）时欢迎 Hero + 输入框整体垂直居中，会话开始后切回吸底输入 */

const bodyEl = document.body;
const heroEl = document.getElementById("welcome-hero");
const input = document.getElementById("input");

/** 切回聊天态：隐藏欢迎 Hero，消息区恢复显示、输入区恢复吸底 */
export function enterChat() {
  bodyEl.classList.remove("welcome");
  heroEl.classList.add("hidden");
  heroEl.innerHTML = "";
}

/** 进入欢迎态：欢迎语渲染进 Hero（随输入框垂直居中），消息区隐藏 */
export function enterWelcome(larkAvailable = true) {
  const larkHint = larkAvailable
    ? ""
    : '<p class="hero-warn">⚠️ 未检测到本地已安装并登录的 lark CLI——解析飞书/Lark 文档需要本地 <code>lark-cli</code> 通过两步检测（<code>--version</code> 可执行、<code>auth status --json --verify</code> 确认已登录），可用 <code>LARK_CLI</code> 环境变量显式指定或确保 PATH 可用。装好并登录后无需重启，检测会自动重试（刷新页面立即生效）。</p>';
  heroEl.innerHTML =
    '<div class="hero-icon">🤖</div>' +
    '<h1 class="hero-title">你好，我是 Lark 文档助手</h1>' +
    '<p class="hero-desc">把 <b>飞书/Lark 文档链接</b> 和你的问题一起发给我，我会调用本地 Lark CLI 读取文档后回答，并支持多轮追问。</p>' +
    '<p class="hero-example">试试粘贴：<code>https://demo.feishu.cn/docx/doccnABC123xyz</code></p>' +
    larkHint;
  heroEl.classList.remove("hidden");
  bodyEl.classList.add("welcome");
  input.focus();
}
