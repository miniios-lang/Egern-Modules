// =============================================================================
// WorkBuddy 状态查看脚本 (Egern generic, 手动触发)
// -----------------------------------------------------------------------------
// 展示当前已绑定账号 (来自 wb_accounts_v1) 与最近签到记录 (来自 wb_checkin_log_v1)。
// =============================================================================

const STORE_ACCOUNTS = 'wb_accounts_v1';
const STORE_LOG = 'wb_checkin_log_v1';

function loadAccounts(ctx) {
  const s = ctx.storage.get(STORE_ACCOUNTS);
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function loadLog(ctx) {
  const s = ctx.storage.get(STORE_LOG);
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

export default async function (ctx) {
  const accounts = loadAccounts(ctx);
  const log = loadLog(ctx).slice(0, 8);

  let body = '账号数量: ' + accounts.length + '\n';
  accounts.forEach((a, i) => {
    const exp = a.expiresAt ? new Date(a.expiresAt * 1000).toLocaleString() : '未知';
    const hasToken = a.accessToken ? '✓' : '✗';
    const hasRefresh = a.refreshToken ? '✓' : '✗';
    body += (i + 1) + '. ' + (a.label || a.uid || '?') +
      '  uid=' + (a.uid || '-') +
      '  token=' + hasToken + ' refresh=' + hasRefresh +
      '  过期=' + exp + '\n';
  });

  body += '\n最近签到记录:\n';
  if (!log.length) {
    body += '(无)';
  } else {
    log.forEach(l => {
      const t = new Date(l.ts).toLocaleString();
      body += t + '  ' + (l.label || '') + ': ' + (l.ok ? '✓ ' : '✗ ') + (l.msg || '') + '\n';
    });
  }

  ctx.notify({ title: 'WorkBuddy 状态', body: body });
}
