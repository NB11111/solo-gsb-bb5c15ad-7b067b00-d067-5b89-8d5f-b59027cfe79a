/* 确认延迟诊断前端库：从复盘单场数据（/api/replay/sessions/:fileId/:runId 的
 * 只读 GET 返回）重建逐口令、逐修订轮次的确认瀑布。
 *
 * 口径：
 *   - 轮次按 attemptId 重建：cue-started（第 1 版）/ cue-resent（修订版）开启
 *     轮次，cue-completed / cue-recalled 闭合轮次；旧日志缺 attemptId 的事件
 *     兜底归入该序号当前未闭合轮次；
 *   - 等待时长 = 确认时刻 − 轮次开始时刻 − 窗口内暂停区间（cue-paused →
 *     cue-resumed）重叠部分，未闭合的暂停以轮次结束为终点；
 *   - 替岗（position-substituted）后确认权移交替补：其后的确认计入接管岗位，
 *     超时未确认标记同样随确认权移交；
 *   - 迟到确认（confirm-late）与超时（cue-timeout）保留标记，不互相覆盖。
 *
 * 只读保证：本文件为纯函数库，不发起网络请求、不创建 WebSocket、不读写任何
 * 存储，绝不影响当前演出状态或事件日志。
 */
'use strict';

const CueLatency = (() => {
  // 条目结果分类
  const RESULT_LABELS = {
    confirmed: '已确认',
    late: '迟到确认',
    timeout: '超时未确认',
    unconfirmed: '未确认',
  };
  // 轮次结局
  const END_STATE_LABELS = {
    completed: '已完成',
    recalled: '已撤回',
    interrupted: '中断',
  };

  // 区间 [a, b] 与暂停区间列表的总重叠时长（ms）。
  // 暂停形如 { startT, endT }；endT 为 null（轮次结束时仍暂停）时以 fallbackEnd 兜底。
  function pauseOverlapMs(pauses, a, b, fallbackEnd) {
    let total = 0;
    for (const p of pauses) {
      const end = p.endT != null ? p.endT : fallbackEnd;
      if (end == null) continue;
      const lo = Math.max(a, p.startT);
      const hi = Math.min(b, end);
      if (hi > lo) total += hi - lo;
    }
    return total;
  }

  function newRound(seq, revision, attemptId, startT, text) {
    return {
      seq,
      revision,
      attemptId: attemptId || null,
      text: text || '',
      reason: null, // 撤回/修订原因（cue-recalled 或 cue-resent 携带）
      startT,
      endT: null,
      endState: 'open', // open | completed | recalled | interrupted
      durationMs: 0,
      pauseMs: 0, // 轮次窗口内暂停总时长
      pauses: [], // [{ startT, endT, reason }]
      confirms: [], // [{ position, t, late }]（原始确认事件，结算时归属到岗位槽）
      timeouts: [], // [{ t, missing }]
      subs: [], // [{ from, to, t }]
      slots: [], // 结算后每目标岗位一行
      extras: [], // 无法归属到任何目标岗位的确认（防御：正常日志不会出现）
    };
  }

  // 结算单个轮次：替岗归属 → 超时标记 → 确认归属 → 等待时长（扣除暂停）
  function finalizeRound(cue, round) {
    const endT = round.endT != null ? round.endT : round.startT;
    round.durationMs = Math.max(0, endT - round.startT);
    // 轮次结束时仍处暂停的区间，以轮次结束时刻闭合（防御：正常流程不会暂停中结束轮次）
    round.pauses.forEach((p) => { if (p.endT == null) p.endT = endT; });
    round.pauseMs = pauseOverlapMs(round.pauses, round.startT, endT, endT);

    const slots = cue.targets.map((target) => ({
      target, // 导演编排的原目标岗位
      effective: target, // 有效岗位（替岗后为接管岗位）
      substituted: false,
      substituteT: null,
      confirm: null, // { position, t, late }
      timedOut: false,
      timeoutT: null,
      result: 'unconfirmed',
      waitMs: 0, // 有效等待时长：条形窗口 − 窗口内暂停
      pauseDeductMs: 0, // 等待窗口内扣除的暂停时长
      barEndT: endT, // 条形末端：确认时刻；未确认则为轮次结束
      jumpT: round.startT, // 跳回复盘的对应事件时刻
    }));

    // 替岗：确认权移交替补岗位（仅本轮次；同一原岗位至多被替一次）
    for (const sub of round.subs) {
      const slot = slots.find((s) => s.target === sub.from && !s.substituted);
      if (slot) {
        slot.effective = sub.to;
        slot.substituted = true;
        slot.substituteT = sub.t;
      }
    }

    // 超时：missing 记录的是超时时刻的有效岗位（替岗后标记随确认权移交替补）
    for (const to of round.timeouts) {
      for (const m of to.missing) {
        const slot = slots.find((s) => s.effective === m && !s.timedOut)
          || slots.find((s) => s.target === m && !s.timedOut);
        if (slot) {
          slot.timedOut = true;
          slot.timeoutT = to.t;
        }
      }
    }

    // 确认归属：按有效岗位匹配（替岗后的确认计入接管岗位）；已确认槽位不再重复占用
    for (const c of round.confirms) {
      const slot = slots.find((s) => !s.confirm && s.effective === c.position)
        || slots.find((s) => !s.confirm && s.target === c.position);
      if (slot) slot.confirm = c;
      else round.extras.push(c);
    }

    for (const slot of slots) {
      if (slot.confirm) {
        slot.result = slot.confirm.late ? 'late' : 'confirmed';
        slot.barEndT = slot.confirm.t;
        slot.jumpT = slot.confirm.t;
      } else if (slot.timedOut) {
        slot.result = 'timeout';
        slot.jumpT = slot.timeoutT; // 跳回复盘的超时事件
      } else {
        slot.result = 'unconfirmed';
        slot.jumpT = round.startT; // 无对应事件：跳到轮次开始
      }
      slot.pauseDeductMs = pauseOverlapMs(round.pauses, round.startT, slot.barEndT, endT);
      slot.waitMs = Math.max(0, (slot.barEndT - round.startT) - slot.pauseDeductMs);
    }
    round.slots = slots;
  }

  // 主入口：从复盘单场数据重建逐口令确认瀑布。
  // sessionData 为 /api/replay/sessions/:fileId/:runId 的返回（events 保持日志行序，
  // 每条含相对本场起点的毫秒偏移 t）。返回 { cues, positions, summary }。
  function diagnose(sessionData) {
    const events = Array.isArray(sessionData && sessionData.events) ? sessionData.events : [];
    const cues = new Map(); // seq -> { seq, text, finalText, targets, rounds }
    const openByAttempt = new Map(); // attemptId -> 未闭合轮次
    const openBySeq = new Map(); // seq -> 未闭合轮次（无 attemptId 事件的兜底归属）

    const ensureCue = (seq) => {
      let c = cues.get(seq);
      if (!c) {
        c = { seq, text: '', finalText: '', targets: [], rounds: [] };
        cues.set(seq, c);
      }
      return c;
    };

    const closeRound = (round, endState, t) => {
      round.endT = t;
      round.endState = endState;
      if (round.attemptId && openByAttempt.get(round.attemptId) === round) {
        openByAttempt.delete(round.attemptId);
      }
      if (openBySeq.get(round.seq) === round) openBySeq.delete(round.seq);
    };

    // 事件归属轮次：attemptId 精确匹配优先；缺失时兜底归入该序号当前未闭合轮次
    const roundFor = (seq, attemptId) => {
      if (attemptId != null && attemptId !== '') return openByAttempt.get(attemptId) || null;
      return openBySeq.get(seq) || null;
    };

    for (const ev of events) {
      const d = (ev && ev.detail) || {};
      const seq = Number(d.seq);
      switch (ev.event) {
        case 'cue-started': {
          if (!Number.isInteger(seq) || seq <= 0) break;
          const cue = ensureCue(seq);
          if (!cue.text) {
            cue.text = String(d.text || '');
            cue.finalText = cue.text;
          }
          if (!cue.targets.length && Array.isArray(d.targets)) {
            cue.targets = [...new Set(d.targets.map((t) => String(t).trim()).filter(Boolean))];
          }
          const prev = openBySeq.get(seq);
          if (prev) closeRound(prev, 'interrupted', ev.t); // 防御：上一轮次未见闭合事件
          const round = newRound(seq, Number(d.revision) || 1, d.attemptId, ev.t, String(d.text || cue.text));
          cue.rounds.push(round);
          if (round.attemptId) openByAttempt.set(round.attemptId, round);
          openBySeq.set(seq, round);
          break;
        }
        case 'cue-resent': {
          if (!Number.isInteger(seq) || seq <= 0) break;
          const cue = ensureCue(seq);
          if (d.text) cue.finalText = String(d.text);
          const prev = openBySeq.get(seq);
          if (prev) closeRound(prev, 'interrupted', ev.t); // 防御：正常流程已由 cue-recalled 闭合
          const round = newRound(
            seq,
            Number(d.revision) || (cue.rounds.length + 1),
            d.attemptId,
            ev.t,
            String(d.text || cue.finalText || cue.text)
          );
          round.reason = d.reason ? String(d.reason) : null; // 本次修订的撤回原因
          cue.rounds.push(round);
          if (round.attemptId) openByAttempt.set(round.attemptId, round);
          openBySeq.set(seq, round);
          break;
        }
        case 'cue-recalled': {
          const round = roundFor(seq, d.oldAttemptId);
          if (round) {
            if (d.reason) round.reason = String(d.reason);
            closeRound(round, 'recalled', ev.t);
          }
          break;
        }
        case 'cue-completed': {
          const round = roundFor(seq, d.attemptId);
          if (round) closeRound(round, 'completed', ev.t);
          break;
        }
        case 'cue-paused': {
          const round = roundFor(seq, d.attemptId);
          if (round) {
            round.pauses.push({ startT: ev.t, endT: null, reason: d.reason ? String(d.reason) : '' });
          }
          break;
        }
        case 'cue-resumed': {
          const round = roundFor(seq, d.attemptId);
          if (round) {
            const open = [...round.pauses].reverse().find((p) => p.endT == null);
            if (open) open.endT = ev.t;
          }
          break;
        }
        case 'confirm':
        case 'confirm-late': {
          const round = roundFor(seq, d.attemptId);
          const position = String(d.position || '').trim();
          if (round && position) {
            round.confirms.push({ position, t: ev.t, late: ev.event === 'confirm-late' });
          }
          break;
        }
        case 'cue-timeout': {
          const round = roundFor(seq, d.attemptId);
          if (round) {
            round.timeouts.push({
              t: ev.t,
              missing: Array.isArray(d.missing) ? d.missing.map(String) : [],
            });
          }
          break;
        }
        case 'position-substituted': {
          const round = roundFor(seq, d.attemptId);
          const from = String(d.from || '').trim();
          const to = String(d.to || '').trim();
          if (round && from && to) round.subs.push({ from, to, t: ev.t });
          break;
        }
        default:
          break;
      }
    }

    // 防御：场次结束时仍未闭合的轮次按最后事件时刻闭合为中断
    const lastT = events.length ? events[events.length - 1].t : 0;
    for (const cue of cues.values()) {
      for (const round of cue.rounds) {
        if (round.endState === 'open') closeRound(round, 'interrupted', lastT);
      }
    }

    // 逐轮次结算 + 汇总
    const positions = [];
    const seenPos = new Set();
    const notePos = (p) => {
      if (p && !seenPos.has(p)) {
        seenPos.add(p);
        positions.push(p);
      }
    };
    const summary = {
      cues: 0, rounds: 0, slots: 0,
      confirmed: 0, late: 0, timeout: 0, unconfirmed: 0,
      substitutions: 0, pauses: 0,
    };

    const cueList = [...cues.values()].sort((a, b) => a.seq - b.seq);
    for (const cue of cueList) {
      summary.cues += 1;
      for (const round of cue.rounds) {
        finalizeRound(cue, round);
        summary.rounds += 1;
        summary.pauses += round.pauses.length;
        summary.substitutions += round.subs.length;
        for (const slot of round.slots) {
          summary.slots += 1;
          summary[slot.result] += 1;
          notePos(slot.target);
          if (slot.substituted) notePos(slot.effective);
        }
      }
    }

    return { cues: cueList, positions, summary };
  }

  // 岗位筛选口径：原目标或替岗后的接管岗位涉及该岗位即命中
  function slotInvolvesPosition(slot, position) {
    return slot.target === position || slot.effective === position;
  }

  return { RESULT_LABELS, END_STATE_LABELS, pauseOverlapMs, diagnose, slotInvolvesPosition };
})();

// Node 环境（测试）可直接 require；浏览器经 <script> 引入为全局 CueLatency
if (typeof module !== 'undefined' && module.exports) module.exports = CueLatency;
