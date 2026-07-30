// =============================================================================
// WorkBuddy 每日签到脚本 (Egern schedule)
// -----------------------------------------------------------------------------
// 功能:
//   - 读取多账号 (优先级: 配置 ACCOUNTS_JSON > 脚本持久化存储 wb_accounts_v1)
//   - 必要时用 refreshToken 自动刷新 accessToken (过期前 5 分钟或缺失时刷新)
//   - 逐个执行每日签到 (POST /v2/billing/meter/daily-checkin)
//   - 记录签到结果 (成功/失败 + 响应信息) 到 wb_checkin_log_v1
//   - 发送汇总通知
//
// 接口依据: https://github.com/Sliverkiss/workbuddy2api
//   refresh: POST {chatBase}/v2/plugin/auth/token/refresh
//   checkin: POST {billingBase}/v2/billing/meter/daily-checkin
// =============================================================================

const STORE_ACCOUNTS = 'wb_accounts_v1';
const STORE_LOG = 'wb_checkin_log_v1';

// 区服判定: domain 为 workbuddy.ai 视为 global, 否则 cn
function isGlobal(domain) {
  return !!(domain && (domain === 'workbuddy.ai' || domain.endsWith('.workbuddy.ai')));
}
function chatBaseFor(domain) {
  return isGlobal(domain) ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com';
}
function billingBaseFor(acct) {
  return isGlobal(acct && acct.domain) ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
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

// 统一解析响应: 返回 { status, json, text }
async function parseResp(resp) {
  let text = '';
  try { text = await resp.text(); } catch (e) { text = ''; }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: resp.status, json: json, text: text };
}

// 解信封: 返回 data 字段 (WorkBuddy 统一 {code,msg,data})
function unwrap(json) {
  if (!json) return null;
  if (typeof json.code === 'number' && json.data !== undefined) return json.data;
  return json;
}

// -----------------------------------------------------------------------------
// 刷新 accessToken
//   端点: POST {chatBase}/v2/plugin/auth/token/refresh
//   关键头: X-Refresh-Token, X-Enterprise-Id, X-Auth-Refresh-Source
// -----------------------------------------------------------------------------
async function refreshToken(ctx, acct) {
  const base = chatBaseFor(acct.domain);
  const headers = commonHeaders(originFor(acct.domain));
  headers['X-Refresh-Token'] = acct.refreshToken;
  if (acct.enterpriseId) headers['X-Enterprise-Id'] = acct.enterpriseId;
  headers['X-Auth-Refresh-Source'] = 'workbuddy';

  const resp = await ctx.http.post(base + '/v2/plugin/auth/token/refresh', {
    headers: headers,
    body: '',
    timeout: 15000
  });
  const { status, json } = await parseResp(resp);

  if (status >= 500) throw new Error('刷新服务异常 HTTP ' + status);
  if (status >= 400) {
    const msg = (json && json.msg) ? json.msg : '';
    throw new Error('刷新失败 HTTP ' + status + ' ' + String(msg).slice(0, 120));
  }
  const data = unwrap(json);
  if (!data || !data.accessToken) {
    throw new Error('刷新响应缺少 accessToken, 可能需要重新登录');
  }
  acct.accessToken = data.accessToken;
  if (data.refreshToken) acct.refreshToken = data.refreshToken;
  if (data.domain) acct.domain = data.domain;
  if (data.expiresIn && data.expiresIn > 0) {
    acct.expiresAt = Math.floor(Date.now() / 1000) + data.expiresIn;
  }
  return acct;
}

// -----------------------------------------------------------------------------
// 每日签到
//   端点: POST {billingBase}/v2/billing/meter/daily-checkin  body: {}
//   头: Authorization: Bearer, X-User-Id, X-Enterprise-Id, X-Tenant-Id, X-Domain
//   响应: {code:0,msg,data} 成功; 已签到业务码(如 10001)视为今日已签
// -----------------------------------------------------------------------------
async function dailyCheckin(ctx, acct) {
  const base = billingBaseFor(acct);
  const headers = {
    'Authorization': 'Bearer ' + acct.accessToken,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  if (acct.uid) headers['X-User-Id'] = acct.uid;
  if (acct.enterpriseId) {
    headers['X-Enterprise-Id'] = acct.enterpriseId;
    headers['X-Tenant-Id'] = acct.enterpriseId;
  }
  if (acct.domain) headers['X-Domain'] = acct.domain;

  const resp = await ctx.http.post(base + '/v2/billing/meter/daily-checkin', {
    headers: headers,
    body: '{}',
    timeout: 15000
  });
  const { status, json } = await parseResp(resp);

  if (status >= 500) throw new Error('签到服务异常 HTTP ' + status);
  if (status >= 400) {
    // 已签到等业务错误也可能走 4xx
    const msg = (json && json.msg) ? json.msg : ('HTTP ' + status);
    if (/已签到|already|今天|重复|10001/i.test(msg)) return { ok: true, msg: '今日已签到' };
    return { ok: false, msg: String(msg).slice(0, 120) };
  }
  if (json && typeof json.code === 'number' && json.code === 0) {
    return { ok: true, msg: '签到成功' };
  }
  const msg = (json && json.msg) ? json.msg : '未知响应';
  if (/已签到|already|今天|重复|10001/i.test(msg)) return { ok: true, msg: '今日已签到' };
  return { ok: false, msg: String(msg).slice(0, 120) };
}

// -----------------------------------------------------------------------------
// 持久化存储辅助
// -----------------------------------------------------------------------------
function loadAccounts(ctx) {
  const s = ctx.storage.get(STORE_ACCOUNTS);
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function saveAccounts(ctx, arr) {
  ctx.storage.set(STORE_ACCOUNTS, JSON.stringify(arr));
}
function loadLog(ctx) {
  const s = ctx.storage.get(STORE_LOG);
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function appendLog(ctx, entry, retention) {
  const log = loadLog(ctx);
  log.unshift(entry);
  if (log.length > retention) log.length = retention;
  ctx.storage.set(STORE_LOG, JSON.stringify(log));
}

// -----------------------------------------------------------------------------
// 主流程
// -----------------------------------------------------------------------------
export default async function (ctx) {
  const env = ctx.env || {};
  const notify = (env.NOTIFY || 'true') !== 'false';
  const retention = Math.max(1, parseInt(env.LOG_RETENTION || '30', 10) || 30);

  // 解析账号: 优先 ACCOUNTS_JSON, 否则用存储
  let accounts = [];
  const envRaw = env.ACCOUNTS_JSON;
  if (envRaw && envRaw.trim() && envRaw.trim() !== '[]') {
    try { const a = JSON.parse(envRaw); if (Array.isArray(a)) accounts = a; } catch (e) { /* 忽略解析错误 */ }
  }
  if (!accounts.length) accounts = loadAccounts(ctx);

  if (!accounts.length) {
    if (notify) ctx.notify({
      title: 'WorkBuddy 签到',
      body: '未检测到账号。\n请先运行「WorkBuddy 登录 (添加账号)」脚本, 或在配置面板填写 ACCOUNTS_JSON。'
    });
    return;
  }

  const results = [];
  for (const acct of accounts) {
    const label = acct.label || acct.nickname || acct.uid || '未知账号';
    try {
      const now = Math.floor(Date.now() / 1000);
      const needRefresh = !acct.accessToken || !acct.refreshToken ||
        !acct.expiresAt || (acct.expiresAt - now) < 300;
      if (needRefresh) {
        if (!acct.refreshToken) throw new Error('缺少 refreshToken, 请重新登录');
        await refreshToken(ctx, acct);
      }
      const r = await dailyCheckin(ctx, acct);
      results.push({ label: label, ok: r.ok, msg: r.msg });
      appendLog(ctx, { uid: acct.uid || '', label: label, ts: Date.now(), ok: r.ok, msg: r.msg }, retention);
    } catch (e) {
      results.push({ label: label, ok: false, msg: e.message });
      appendLog(ctx, { uid: acct.uid || '', label: label, ts: Date.now(), ok: false, msg: e.message }, retention);
    }
  }

  // 持久化刷新后的 token (便于后续以存储方式复用)
  saveAccounts(ctx, accounts);

  const okCount = results.filter(r => r.ok).length;
  const summary = results.map(r => (r.ok ? '✓ ' : '✗ ') + r.label + ': ' + r.msg).join('\n');
  if (notify) {
    ctx.notify({ title: 'WorkBuddy 签到 ' + okCount + '/' + results.length, body: summary });
  }
}
