/**
 * Egern 定时脚本 — WorkBuddy / CodeBuddy CN 自动签到（内置自动获取 Token）。
 *
 * 设计要点：
 *  1. 优先使用 env 中的 AUTH_TOKEN（手动抓包方式，向下兼容）。
 *  2. 若设置了 REFRESH_TOKEN，则每次签到前自动调用刷新接口换取最新 accessToken，
 *     之后无需再手动更新 token（refreshToken 有效期较长）。
 *  3. 首次使用需先通过设备流拿到 refreshToken（见下方说明），填到模块 Env 即可。
 *  4. 所有密钥一律从 ctx.env 读取，绝不写入本文件。
 */

export default async function workBuddyAutoCheckin(ctx) {
  const env = ctx.env || {};
  const notify = (env.NOTIFY || "true").toLowerCase() !== "false";
  function sendNotification(title, body) {
    if (notify) ctx.notify({ title, body });
  }

  const upstreamBase = "https://copilot.tencent.com";
  const billingBase = "https://www.codebuddy.cn";
  const commonUA = "CLI/2.63.2 CodeBuddy/2.63.2";

  // 账号身份信息（来自设备流返回，可持久化保存在 Env 中）
  const uid = (env.USER_ID || "").trim();
  const enterpriseId = (env.ENTERPRISE_ID || "").trim();
  let domain = (env.DOMAIN || "").trim();

  // 解包上游 {code,msg,data} 信封；失败抛出业务错误
  async function unwrap(resp) {
    const raw = await resp.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      if (resp.status >= 200 && resp.status < 300) return {};
      throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 120)}`);
    }
    if (json.code !== undefined && json.code !== 0) {
      throw new Error(`code=${json.code} ${json.msg || ""}`.trim());
    }
    return json.data !== undefined ? json.data : json;
  }

  // 通用请求头
  function commonHeaders(extra) {
    return Object.assign({
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      "Origin": billingBase,
      "Referer": billingBase + "/",
      "User-Agent": commonUA,
    }, extra || {});
  }

  // 用 refreshToken 换取最新 accessToken
  async function refreshAccessToken(refreshToken) {
    const url = `${upstreamBase}/v2/plugin/auth/token/refresh`;
    const headers = commonHeaders({
      "X-Refresh-Token": refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
    });
    if (enterpriseId) headers["X-Enterprise-Id"] = enterpriseId;
    const resp = await ctx.http.post(url, { headers, body: {}, timeout: 25000, credentials: "include" });
    const data = await unwrap(resp);
    const bundle = {
      accessToken: data.accessToken || "",
      refreshToken: data.refreshToken || refreshToken,
      expiresIn: data.expiresIn ?? 0,
      domain: data.domain || "",
    };
    if (!bundle.accessToken) throw new Error("刷新失败：未返回 accessToken，可能需要重新登录");
    return bundle;
  }

  // 决定 accessToken
  let accessToken = (env.AUTH_TOKEN || "").trim();
  const refreshToken = (env.REFRESH_TOKEN || "").trim();

  if (!accessToken && !refreshToken) {
    // 设备流引导（可选）：发一条通知，让用户去浏览器完成首次登录
    if ((env.DEVICE_FLOW_BOOTSTRAP || "false").toLowerCase() === "true") {
      try {
        const url = `${upstreamBase}/v2/plugin/auth/state?platform=CLI`;
        const resp = await ctx.http.post(url, { headers: commonHeaders(), body: {}, timeout: 25000 });
        const data = await unwrap(resp);
        if (!data.authUrl) throw new Error("未返回 authUrl");
        sendNotification(
          "WorkBuddy 首次登录引导",
          `请在浏览器打开以下链接完成登录：\n${data.authUrl}\n登录后把返回的 refreshToken / uid 等填到模块 Env 即可自动签到。`
        );
      } catch (e) {
        sendNotification("WorkBuddy 登录引导失败", e.message.slice(0, 160));
      }
      return;
    }
    sendNotification("WorkBuddy 签到跳过", "请在模块 Env 中设置 AUTH_TOKEN 或 REFRESH_TOKEN。");
    return;
  }

  // 自动获取 / 刷新 token
  if (!accessToken && refreshToken) {
    try {
      const bundle = await refreshAccessToken(refreshToken);
      accessToken = bundle.accessToken;
      if (bundle.domain) domain = bundle.domain;
    } catch (e) {
      sendNotification("WorkBuddy 签到失败", "刷新 token 失败：" + e.message.slice(0, 140));
      return;
    }
  }

  // 签到请求
  const checkinUrl = (env.CHECKIN_URL || `${billingBase}/v2/billing/meter/daily-checkin`).trim();
  const method = (env.CHECKIN_METHOD || "POST").trim().toUpperCase();
  if (!["GET", "POST", "PUT"].includes(method)) {
    sendNotification("WorkBuddy 签到跳过", "CHECKIN_METHOD 必须为 GET、POST 或 PUT。");
    return;
  }

  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (uid) headers["X-User-Id"] = uid;
  if (enterpriseId) {
    headers["X-Enterprise-Id"] = enterpriseId;
    headers["X-Tenant-Id"] = enterpriseId;
  }
  if (domain) headers["X-Domain"] = domain;

  const extraHeaders = (env.EXTRA_HEADERS_JSON || "").trim();
  if (extraHeaders) {
    try {
      const parsed = JSON.parse(extraHeaders);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("not an object");
      Object.assign(headers, parsed);
    } catch {
      sendNotification("WorkBuddy 签到跳过", "EXTRA_HEADERS_JSON 必须为 JSON 对象。");
      return;
    }
  }

  const request = { headers, timeout: 25000, credentials: "include" };
  const rawBody = (env.CHECKIN_BODY || "{}").trim();
  if (method !== "GET" && rawBody) {
    try {
      request.body = JSON.parse(rawBody);
    } catch {
      request.body = rawBody;
    }
  }

  try {
    let response;
    if (method === "GET") response = await ctx.http.get(checkinUrl, request);
    else if (method === "PUT") response = await ctx.http.put(checkinUrl, request);
    else response = await ctx.http.post(checkinUrl, request);

    const rawResponse = await response.text();
    let message = "";
    try {
      const data = JSON.parse(rawResponse);
      message = String(
        data.message ?? data.msg ?? data.statusMessage ?? data.detail ?? data.code ?? ""
      ).trim();
    } catch {
      message = rawResponse.replace(/\s+/g, " ").trim();
    }
    message = message.slice(0, 160) || `HTTP ${response.status}`;

    if (response.status >= 200 && response.status < 300) {
      sendNotification("WorkBuddy 签到成功", message);
    } else {
      sendNotification("WorkBuddy 签到失败", `HTTP ${response.status}: ${message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendNotification("WorkBuddy 签到异常", message.slice(0, 160));
  }
}
