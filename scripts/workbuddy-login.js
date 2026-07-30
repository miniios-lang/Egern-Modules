// =============================================================================
// WorkBuddy 登录脚本 (Egern generic, 手动触发) — 添加 / 绑定账号
// -----------------------------------------------------------------------------
// OAuth 设备流 (无 PKCE, state 由服务端签发), 与 workbuddy2api 登录逻辑一致:
//   1. POST {chatBase}/v2/plugin/auth/state?platform=CLI  → 拿到 state + authUrl
//       (state 暂存于 wb_login_state_v1, 并推送授权链接给用户)
//   2. 用户在浏览器完成登录后, 再次运行本脚本:
//      GET  {chatBase}/v2/plugin/auth/token?state=     → accessToken / refreshToken / expiresIn / domain
//      GET  {chatBase}/v2/plugin/login/account?state=  → uid / enterpriseId / nickname
//   3. 账号写入持久化存储 wb_accounts_v1, 供签到脚本读取 (多账号互不影响)
// =============================================================================

const STORE_ACCOUNTS = 'wb_accounts_v1';
const STORE_STATE = 'wb_login_state_v1';

function isGlobal(domain) {
  return !!(domain && (domain === 'workbuddy.ai' || domain.endsWith('.workbuddy.ai')));
}
function chatBaseFor(domain) {
  return isGlobal(domain) ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com';
}
function originFor(domain) {
  return isGlobal(domain) ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
}
function commonHeaders(origin) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': origin + '/',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2'
  };
}
async function parseResp(resp) {
  let text = '';
  try { text = await resp.text(); } catch (e) { text = ''; }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: resp.status, json: json, text: text };
}
function unwrap(json) {
  if (!json) return null;
  if (typeof json.code === 'number' && json.data !== undefined) return json.data;
  return json;
}
function loadAccounts(ctx) {
  const s = ctx.storage.get(STORE_ACCOUNTS);
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function saveAccounts(ctx, arr) {
  ctx.storage.set(STORE_ACCOUNTS, JSON.stringify(arr));
}

export default async function (ctx) {
  const env = ctx.env || {};
  const region = env.REGION_DEFAULT === 'global' ? 'workbuddy.ai' : '';
  const base = chatBaseFor(region);
  const origin = originFor(region);

  const pending = ctx.storage.get(STORE_STATE);

  // ---- 第一步: 申请 state + 授权链接 ----
  if (!pending) {
    const headers = commonHeaders(origin);
    const resp = await ctx.http.post(base + '/v2/plugin/auth/state?platform=CLI', {
      headers: headers,
      body: '{}',
      timeout: 15000
    });
    const { status, json } = await parseResp(resp);
    if (status >= 400 || !json) throw new Error('获取授权链接失败 HTTP ' + status);

    const data = unwrap(json);
    if (!data || !data.state) throw new Error('响应缺少 state');

    ctx.storage.set(STORE_STATE, JSON.stringify({ state: data.state, ts: Date.now() }));
    ctx.notify({
      title: 'WorkBuddy 登录 (1/2)',
      body: '请在浏览器打开下方链接完成登录, 然后再次运行本脚本完成绑定:\n' + (data.authUrl || '(未返回 authUrl)')
    });
    return;
  }

  // ---- 第二步: 轮询 token (pending 存在) ----
  const p = (function () { try { return JSON.parse(pending); } catch (e) { return {}; } })();
  if (!p.state) {
    ctx.storage.delete(STORE_STATE);
    ctx.notify({ title: 'WorkBuddy 登录', body: '登录状态损坏, 请重新运行本脚本。' });
    return;
  }

  const headers = commonHeaders(origin);
  const resp = await ctx.http.get(base + '/v2/plugin/auth/token?state=' + encodeURIComponent(p.state), {
    headers: headers,
    timeout: 15000
  });
  const { status, json } = await parseResp(resp);

  // pending 时业务 code 非 0 (如 "login ing"), 或 HTTP 非 2xx → 视为未完成
  if (status >= 400 || !json) {
    ctx.notify({ title: 'WorkBuddy 登录', body: '登录尚未完成, 请先在浏览器完成登录后重试。' });
    return;
  }
  const data = unwrap(json);
  if (!data || !data.accessToken) {
    ctx.notify({ title: 'WorkBuddy 登录', body: '登录尚未完成 (waiting)。请确认已在浏览器完成登录, 然后再次运行本脚本。' });
    return;
  }

  // ---- 获取账号信息 (uid / enterpriseId / nickname) ----
  let acctInfo = {};
  try {
    const ah = commonHeaders(origin);
    ah['Authorization'] = 'Bearer ' + data.accessToken;
    const ar = await ctx.http.get(base + '/v2/plugin/login/account?state=' + encodeURIComponent(p.state), {
      headers: ah,
      timeout: 15000
    });
    const ap = await parseResp(ar);
    if (ap.json) acctInfo = unwrap(ap.json) || {};
  } catch (e) { /* 忽略, 使用默认值 */ }

  const accounts = loadAccounts(ctx);
  const acct = {
    label: acctInfo.nickname || ('账号' + (accounts.length + 1)),
    uid: acctInfo.uid || '',
    enterpriseId: acctInfo.enterpriseId || '',
    nickname: acctInfo.nickname || '',
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || '',
    expiresAt: Math.floor(Date.now() / 1000) + (data.expiresIn || 0),
    domain: data.domain || region
  };

  // 去重 (按 uid); 无 uid 则追加
  const idx = accounts.findIndex(a => a.uid && a.uid === acct.uid);
  if (idx >= 0) accounts[idx] = acct; else accounts.push(acct);
  saveAccounts(ctx, accounts);
  ctx.storage.delete(STORE_STATE);

  ctx.notify({
    title: 'WorkBuddy 登录成功 (2/2)',
    body: '已保存账号: ' + (acct.nickname || acct.uid) + '\n当前共 ' + accounts.length + ' 个账号。'
  });
}
