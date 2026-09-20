/* 确认延迟诊断模块测试：attemptId 轮次重建、暂停扣除、替岗归属、迟到/超时标记、
 * 旧日志兜底、筛选口径与只读页面/接口约束。
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 * 诊断逻辑直接 require public/latency.js（浏览器同源代码），并经 replay.js 的
 * 只读解析器对合成日志做端到端验证；HTTP 部分对真实 data 目录断言。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const replay = require('../replay');
const CueLatency = require('../public/latency');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${urlPath}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf, json: buf && res.headers['content-type'] && res.headers['content-type'].includes('json') ? JSON.parse(buf) : null }));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 合成日志：4 条口令，覆盖暂停扣除、超时→替岗→迟到、修订轮次、超时未确认
// ---------------------------------------------------------------------------
const SESSION_MAIN = '1a2b3c4d-1111-2222-3333-444444444444';
const SESSION_LEGACY = '5e6f7a8b-1111-2222-3333-444444444444';
const BASE = Date.parse('2026-09-19T10:00:00.000Z');
const iso = (ms) => new Date(BASE + ms).toISOString();

function writeSynthLogs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const main = [
    [0, 'sequence-set', { timeoutSec: 10, cues: [] }],
    [0, 'session-start', {}],
    // #1 [灯光,音响]：暂停 2s→8s（6 秒），恢复后确认
    [0, 'cue-started', { seq: 1, text: '开场灯光', targets: ['灯光', '音响'], revision: 1, attemptId: 'c1' }],
    [2000, 'cue-paused', { seq: 1, revision: 1, attemptId: 'c1', reason: '设备调试' }],
    [8000, 'cue-resumed', { seq: 1, revision: 1, attemptId: 'c1' }],
    [9000, 'confirm', { seq: 1, revision: 1, attemptId: 'c1', position: '灯光' }],
    [9500, 'confirm', { seq: 1, revision: 1, attemptId: 'c1', position: '音响' }],
    [9500, 'cue-completed', { seq: 1, revision: 1, attemptId: 'c1' }],
    // #2 [道具]：超时 → 替岗给灯光 → 灯光迟到确认（计入接管岗位，标记保留）
    [9500, 'cue-started', { seq: 2, text: '道具就位', targets: ['道具'], revision: 1, attemptId: 'c2' }],
    [19500, 'cue-timeout', { seq: 2, revision: 1, attemptId: 'c2', missing: ['道具'] }],
    [20000, 'position-substituted', { seq: 2, revision: 1, attemptId: 'c2', from: '道具', to: '灯光' }],
    [21000, 'confirm-late', { seq: 2, revision: 1, attemptId: 'c2', position: '灯光' }],
    [21000, 'cue-completed', { seq: 2, revision: 1, attemptId: 'c2' }],
    // #3 [灯光,音响]：第 1 版部分确认后撤回，第 2 版暂停后完成
    [21000, 'cue-started', { seq: 3, text: '全场亮灯', targets: ['灯光', '音响'], revision: 1, attemptId: 'c3a' }],
    [22000, 'confirm', { seq: 3, revision: 1, attemptId: 'c3a', position: '灯光' }],
    [23000, 'cue-recalled', { seq: 3, oldRevision: 1, newRevision: 2, oldAttemptId: 'c3a', reason: '措辞修正', newText: '全场亮灯（修正）' }],
    [23000, 'cue-resent', { seq: 3, text: '全场亮灯（修正）', reason: '措辞修正', revision: 2, attemptId: 'c3b' }],
    [24000, 'cue-paused', { seq: 3, revision: 2, attemptId: 'c3b', reason: '二次调试' }],
    [26000, 'cue-resumed', { seq: 3, revision: 2, attemptId: 'c3b' }],
    [27000, 'confirm', { seq: 3, revision: 2, attemptId: 'c3b', position: '灯光' }],
    [27500, 'confirm', { seq: 3, revision: 2, attemptId: 'c3b', position: '音响' }],
    [27500, 'cue-completed', { seq: 3, revision: 2, attemptId: 'c3b' }],
    // #4 [音响,道具]：第 1 版超时未确认后撤回，第 2 版完成
    [27500, 'cue-started', { seq: 4, text: '谢幕', targets: ['音响', '道具'], revision: 1, attemptId: 'c4a' }],
    [37500, 'cue-timeout', { seq: 4, revision: 1, attemptId: 'c4a', missing: ['音响'] }],
    [38000, 'cue-recalled', { seq: 4, oldRevision: 1, newRevision: 2, oldAttemptId: 'c4a', reason: '超时重发', newText: '谢幕' }],
    [38000, 'cue-resent', { seq: 4, text: '谢幕', reason: '超时重发', revision: 2, attemptId: 'c4b' }],
    [38500, 'confirm', { seq: 4, revision: 2, attemptId: 'c4b', position: '音响' }],
    [39000, 'confirm', { seq: 4, revision: 2, attemptId: 'c4b', position: '道具' }],
    [39000, 'cue-completed', { seq: 4, revision: 2, attemptId: 'c4b' }],
    [39000, 'sequence-finished', {}],
  ];
  // 旧格式日志：确认 / 超时 / 完成事件不带 attemptId，应兜底归入当前未闭合轮次
  const legacy = [
    [0, 'session-start', {}],
    [0, 'cue-started', { seq: 1, text: '旧日志口令', targets: ['灯光'], revision: 1, attemptId: 'o1' }],
    [1000, 'confirm', { seq: 1, position: '灯光' }],
    [1500, 'cue-completed', { seq: 1 }],
    [1500, 'cue-started', { seq: 2, text: '旧日志二', targets: ['道具'], revision: 1, attemptId: 'o2' }],
    [3000, 'cue-timeout', { seq: 2, missing: ['道具'] }],
    [4000, 'confirm-late', { seq: 2, position: '道具' }],
    [4500, 'cue-completed', { seq: 2 }],
    [4500, 'sequence-finished', {}],
  ];
  const write = (id, lines) => {
    fs.writeFileSync(path.join(dir, `events-${id}.jsonl`),
      lines.map(([t, event, detail]) => JSON.stringify({ ts: iso(t), event, detail })).join('\n') + '\n');
  };
  write(SESSION_MAIN, main);
  write(SESSION_LEGACY, legacy);
}

function slotOf(round, target) {
  return round.slots.find((s) => s.target === target);
}

async function main() {
  console.log('一、暂停重叠纯函数 pauseOverlapMs');
  const P = CueLatency.pauseOverlapMs;
  check('单段暂停完全包含于窗口', P([{ startT: 1000, endT: 3000 }], 0, 5000) === 2000);
  check('多段暂停累计', P([{ startT: 0, endT: 1000 }, { startT: 2000, endT: 4000 }], 0, 5000) === 3000);
  check('窗口外暂停不计入', P([{ startT: 6000, endT: 9000 }], 0, 5000) === 0);
  check('部分重叠按交集计', P([{ startT: 3000, endT: 9000 }], 0, 5000) === 2000);
  check('未闭合暂停以兜底终点计', P([{ startT: 1000, endT: null }], 0, 5000, 5000) === 4000);
  check('相邻不重叠暂停不重复计', P([{ startT: 0, endT: 1000 }, { startT: 1000, endT: 2000 }], 0, 3000) === 2000);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-latency-'));
  writeSynthLogs(dir);
  const dataMain = replay.getSession(dir, SESSION_MAIN, '0');
  check('合成日志经复盘只读解析器读取成功', !dataMain.error);
  const diag = CueLatency.diagnose(dataMain);

  console.log('二、按 attemptId 重建修订轮次');
  check('4 条口令、6 个轮次', diag.summary.cues === 4 && diag.summary.rounds === 6);
  const [cue1, cue2, cue3, cue4] = diag.cues;
  check('口令 3 重建出 2 个轮次（撤回 + 修订重发）', cue3.rounds.length === 2);
  const [c3r1, c3r2] = cue3.rounds;
  check('轮次按 attemptId 区分（c3a / c3b）且修订号递增',
    c3r1.attemptId === 'c3a' && c3r1.revision === 1 && c3r2.attemptId === 'c3b' && c3r2.revision === 2);
  check('撤回轮次结局为 recalled、重发轮次结局为 completed',
    c3r1.endState === 'recalled' && c3r2.endState === 'completed');
  check('撤回原因记录到两个轮次', c3r1.reason === '措辞修正' && c3r2.reason === '措辞修正');
  check('修订后最终文本更新、原始文本保留',
    cue3.finalText === '全场亮灯（修正）' && cue3.text === '全场亮灯');
  check('轮次起止时刻正确（c3a: 21000→23000，c3b: 23000→27500）',
    c3r1.startT === 21000 && c3r1.endT === 23000 && c3r2.startT === 23000 && c3r2.endT === 27500);

  console.log('三、等待时长扣除暂停区间');
  const c1r1 = cue1.rounds[0];
  check('轮次暂停总时长 6 秒', c1r1.pauseMs === 6000);
  const c1Light = slotOf(c1r1, '灯光');
  check('灯光确认等待 = 9s − 6s 暂停 = 3s',
    c1Light.waitMs === 3000 && c1Light.pauseDeductMs === 6000);
  const c1Sound = slotOf(c1r1, '音响');
  check('音响确认等待 = 9.5s − 6s 暂停 = 3.5s', c1Sound.waitMs === 3500);
  const c3r2Light = slotOf(c3r2, '灯光');
  check('第 2 版灯光等待 = 4s − 2s 暂停 = 2s',
    c3r2Light.waitMs === 2000 && c3r2Light.pauseDeductMs === 2000 && c3r2.pauseMs === 2000);

  console.log('四、替岗后的确认计入接管岗位，迟到与超时保留标记');
  const c2slot = cue2.rounds[0].slots[0];
  check('原目标为道具、有效岗位变为灯光（接管）',
    c2slot.target === '道具' && c2slot.effective === '灯光' && c2slot.substituted === true);
  check('灯光的迟到确认计入该槽位（接管岗位）',
    c2slot.confirm && c2slot.confirm.position === '灯光' && c2slot.confirm.t === 21000);
  check('结果分类为迟到确认', c2slot.result === 'late');
  check('超时标记保留（timedOut + 超时时刻）', c2slot.timedOut === true && c2slot.timeoutT === 19500);
  check('等待时长覆盖到确认时刻（11.5s，无暂停）', c2slot.waitMs === 11500 && c2slot.pauseDeductMs === 0);
  check('点击条目跳转到确认事件时刻', c2slot.jumpT === 21000);
  const c4r1sound = slotOf(cue4.rounds[0], '音响');
  check('超时未确认保留标记（结果 timeout + 超时时刻）',
    c4r1sound.result === 'timeout' && c4r1sound.timedOut === true && c4r1sound.timeoutT === 37500);
  check('超时条目跳转到超时事件时刻', c4r1sound.jumpT === 37500);
  const c4r1prop = slotOf(cue4.rounds[0], '道具');
  check('撤回轮次中未确认岗位分类为 unconfirmed', c4r1prop.result === 'unconfirmed' && !c4r1prop.timedOut);

  console.log('五、汇总与岗位收集');
  check('结果计数：已确认 7 / 迟到 1 / 超时 1 / 未确认 2',
    diag.summary.confirmed === 7 && diag.summary.late === 1 &&
    diag.summary.timeout === 1 && diag.summary.unconfirmed === 2);
  check('槽位总数 11、替岗 1、暂停 2 次',
    diag.summary.slots === 11 && diag.summary.substitutions === 1 && diag.summary.pauses === 2);
  check('岗位收集含接管岗位（灯光/音响/道具，首次出现顺序）',
    JSON.stringify(diag.positions) === JSON.stringify(['灯光', '音响', '道具']));
  check('岗位筛选口径：替岗槽位同时命中原岗位与接管岗位',
    CueLatency.slotInvolvesPosition(c2slot, '道具') && CueLatency.slotInvolvesPosition(c2slot, '灯光') &&
    !CueLatency.slotInvolvesPosition(c2slot, '音响'));

  console.log('六、旧日志兜底（无 attemptId 事件归入当前未闭合轮次）');
  const dataLegacy = replay.getSession(dir, SESSION_LEGACY, '0');
  const diagLegacy = CueLatency.diagnose(dataLegacy);
  check('旧日志读取成功', !dataLegacy.error);
  const [lc1, lc2] = diagLegacy.cues;
  check('无 attemptId 的 confirm / cue-completed 归入当前轮次',
    lc1.rounds.length === 1 && lc1.rounds[0].endState === 'completed' &&
    slotOf(lc1.rounds[0], '灯光').result === 'confirmed');
  check('无 attemptId 的超时与迟到确认同样归属',
    slotOf(lc2.rounds[0], '道具').result === 'late' && slotOf(lc2.rounds[0], '道具').timedOut === true);

  console.log('七、防御：未闭合暂停、无法归属确认、空输入');
  const hand = CueLatency.diagnose({
    events: [
      { t: 0, event: 'cue-started', detail: { seq: 1, text: 'x', targets: ['灯光'], revision: 1, attemptId: 'h1' } },
      { t: 1000, event: 'cue-paused', detail: { seq: 1, attemptId: 'h1', reason: 'r' } },
      { t: 5000, event: 'cue-recalled', detail: { seq: 1, oldAttemptId: 'h1', reason: '撤回' } },
      { t: 5000, event: 'cue-resent', detail: { seq: 1, text: 'x2', revision: 2, attemptId: 'h2' } },
      { t: 6000, event: 'confirm', detail: { seq: 1, attemptId: 'h2', position: '陌生人' } },
      { t: 6000, event: 'confirm', detail: { seq: 1, attemptId: 'h2', position: '灯光' } },
      { t: 6000, event: 'cue-completed', detail: { seq: 1, attemptId: 'h2' } },
    ],
  });
  const hr1 = hand.cues[0].rounds[0];
  check('轮次结束时仍暂停的区间以轮次结束闭合（暂停 4s）', hr1.pauseMs === 4000);
  check('未确认槽位等待 = 5s − 4s 暂停 = 1s', slotOf(hr1, '灯光').waitMs === 1000);
  const hr2 = hand.cues[0].rounds[1];
  check('非目标岗位的确认进入 extras 不污染槽位',
    hr2.extras.length === 1 && hr2.extras[0].position === '陌生人' &&
    slotOf(hr2, '灯光').result === 'confirmed');
  const empty = CueLatency.diagnose({ events: [] });
  check('空事件输入安全（0 口令）', empty.cues.length === 0 && empty.summary.rounds === 0);
  check('非对象输入安全', CueLatency.diagnose(null).cues.length === 0);

  console.log('八、只读 HTTP 约束与真实数据不变量');
  const page = await httpGet('/latency.html');
  check('诊断页面可访问（200）', page.status === 200);
  check('页面不创建 WebSocket', !/new\s+WebSocket/.test(page.body));
  check('页面仅引用复盘只读 GET 接口与 latency.js',
    page.body.includes('/api/replay/sessions') && page.body.includes('latency.js') &&
    !page.body.includes('/api/latency'));
  const noApi = await httpGet('/api/latency/sessions');
  check('模块不新增服务端接口（/api/latency/* 返回 404）', noApi.status === 404);
  const home = await httpGet('/');
  check('首页含确认延迟诊断入口', home.status === 200 && home.body.includes('latency.html'));
  const replayPage = await httpGet('/replay.html');
  check('复盘页导航含确认延迟诊断入口', replayPage.status === 200 && replayPage.body.includes('latency.html'));

  const list = await httpGet('/api/replay/sessions');
  check('复盘场次列表接口可用', list.status === 200 && Array.isArray(list.json.sessions));
  if (list.json.sessions.length) {
    const s0 = list.json.sessions[0];
    const detail = await httpGet(`/api/replay/sessions/${s0.fileId}/${s0.runId}`);
    check('真实场次详情接口可用', detail.status === 200 && Array.isArray(detail.json.events));
    const d = CueLatency.diagnose(detail.json);
    check('真实场次每条口令至少 1 个轮次且全部闭合',
      d.cues.length > 0 && d.cues.every((c) => c.rounds.length >= 1 &&
        c.rounds.every((r) => r.endState !== 'open' && r.endT != null)));
    check('每轮次槽位数等于口令目标数',
      d.cues.every((c) => c.rounds.every((r) => r.slots.length === c.targets.length)));
    check('已完成轮次的全部槽位均为已确认 / 迟到确认',
      d.cues.every((c) => c.rounds.every((r) => r.endState !== 'completed' ||
        r.slots.every((s) => s.result === 'confirmed' || s.result === 'late'))));
    check('等待时长非负且不超过轮次时长',
      d.cues.every((c) => c.rounds.every((r) => r.slots.every((s) =>
        s.waitMs >= 0 && s.pauseDeductMs >= 0 && s.waitMs <= r.durationMs))));
    check('替岗槽位有效岗位不同于原岗位',
      d.cues.every((c) => c.rounds.every((r) => r.slots.every((s) =>
        !s.substituted || s.effective !== s.target))));
    check('汇总槽位数与逐轮次一致',
      d.summary.slots === d.cues.reduce((n, c) => n + c.rounds.reduce((m, r) => m + r.slots.length, 0), 0));
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
