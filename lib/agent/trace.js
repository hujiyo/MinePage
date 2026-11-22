// 执行过程的事件归一化与视图派生 —— **纯函数，不碰数据库、不碰 DOM**。
//
// 为什么单独一个文件：
//   以前「渲染执行过程」这件事有两套实现（实时一套、刷新后一套），
//   两边对「怎么分组、怎么去重、怎么排序」的理解不一致，
//   用户报的「刷新后轮次/图标/折叠状态全对不上」就是那么来的。
//
//   现在把「把事件流变成视图模型」这一步抽成纯函数，
//   实时和历史都调同一个 deriveTrace()，渲染层只负责把 view 画出来。
//   数据相同 → 视图必然相同，这类 bug 从类别上消失。
//
// 事件 schema（v2 为主，v1 兼容）：
//   turn_start  { turn }
//   turn_end    { turn, reason:{kind, ...} }
//   llm_start   { step }                     ← v1 就叫 llm_start，保留
//   step_end    { step, ms, reason }
//   tool_start  { step, name, path }         ← 新增，让「正在读 xxx」有数据
//   tool_end    { step, name, ok, path, error, ms, bytes }
//   retry       { attempt, maxRetries, waitMs, failure:{code,message} }
//   reasoning   { text }                     ← v1 是累积快照
//   reasoning_delta { text }                 ← v2 是增量
//   text        { text }
//
// 兼容原则：**能读 v1 就绝不丢历史**。老数据里 reasoning 是「越来越长的快照」，
// 归一化时按「取最长」去重；新数据是增量，直接拼接。两者在 deriveTrace 里
// 已经统一成「每轮一份完整思考文本」，渲染层不需要知道区别。

/** 文件类工具 → 它们在界面上归进 family=file。 */
const FILE_TOOLS = new Set(['read_file', 'write_file', 'delete_file', 'list_files']);

/** 写入类工具（「改了 N 处」只数这些，list_files/read_file 不算）。 */
const WRITE_TOOLS = new Set(['write_file', 'delete_file', 'update_meta']);

/** 读文件时能被「已读取文件」聚合的工具。 */
const READ_TOOLS = new Set(['read_file']);

const FAMILIES = ['message', 'tool', 'reasoning', 'error', 'file'];

/**
 * 把任意来源的原始事件数组规范成 v2 形状。
 *
 * 幂等：已经是 v2 的进来原样出去（除了补 seq）。
 *
 * @param {Array} raw v1 或 v2 事件数组
 * @returns {Array} 规范后的事件（带 seq，从 1 开始）
 */
export function normalizeEvents(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];

  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;

    // v1 的 reasoning 是「截至当前的完整快照」，这里先原样收下，
    // 真正的去重在下面按 step 取最长时做。
    let type = String(ev.type ?? '');
    let next;

    if (type === 'reasoning') {
      // v1：快照。v2 里同名事件也当快照处理（兼容）
      next = { type: 'reasoning', text: String(ev.text ?? '') };
    } else if (type === 'reasoning_delta') {
      next = { type: 'reasoning_delta', text: String(ev.text ?? '') };
    } else if (type === 'tool_end') {
      next = {
        type: 'tool_end',
        name: String(ev.name ?? ''),
        ok: ev.ok !== false,
        path: ev.path ?? null,
        error: ev.error ?? null,
        ms: Number.isFinite(Number(ev.ms)) ? Number(ev.ms) : null,
      };
    } else if (type === 'tool_start') {
      next = {
        type: 'tool_start',
        name: String(ev.name ?? ''),
        path: ev.path ?? null,
      };
    } else if (type === 'retry') {
      next = {
        type: 'retry',
        attempt: Number(ev.attempt) || 1,
        maxRetries: Number(ev.maxRetries) || 0,
        waitMs: Number(ev.waitMs) || 0,
        failure: {
          code: String(ev.failure?.code ?? ev.code ?? 'UNKNOWN'),
          message: String(ev.failure?.message ?? ev.error ?? '').slice(0, 200),
        },
      };
    } else if (type === 'turn_start' || type === 'turn_end') {
      next = { type, turn: Number(ev.turn) || 1, reason: ev.reason ?? null };
    } else if (type === 'llm_start' || type === 'step_end') {
      next = { type, step: Number(ev.step) || null, ms: ev.ms ?? null, reason: ev.reason ?? null };
    } else if (type === 'text') {
      next = { type: 'text', text: String(ev.text ?? '') };
    } else {
      // 未知类型一律丢弃，不要让它污染视图
      continue;
    }

    next.t = Number(ev.at ?? ev.t) || 0;
    out.push(next);
  }

  // 补 seq：v1 没有 seq，统一按数组顺序编号
  return out.map((ev, i) => ({ ...ev, seq: Number(ev.seq) || i + 1 }));
}

/**
 * 事件序列 → 视图模型。**渲染层只吃这个**。
 *
 * 返回的形状同时服务两种用法：
 *   - turns[]     时间线（步骤卡片，按「轮 → 步」组织）
 *   - families{}  分类视图（筛选胶囊，按事件类型聚合）
 *
 * @param {Array} rawEvents v1 或 v2 事件
 * @param {object} [task] 任务行（取 status 等）
 * @returns {object} view
 */
export function deriveTrace(rawEvents, task = null) {
  const events = normalizeEvents(rawEvents);
  const status = task?.status ?? 'done';

  // ---------------------------------------------------------------
  // 1. 分轮分组
  //
  // 分组依据：优先用显式的 turn_start / llm_start 标记，二者都没有就全部塞一轮。
  // 不用「事件里自带的 step 字段」做主依据 —— 中断/重试时它会重复或跳号。
  // ---------------------------------------------------------------
  const turns = [];
  let curTurn = null;

  const openTurn = (turnNo) => {
    curTurn = {
      turn: turnNo,
      steps: [],
      startedAt: null,
      endedAt: null,
      reason: null,
    };
    turns.push(curTurn);
    return curTurn;
  };

  let implicitTurn = 0;

  for (const ev of events) {
    if (ev.type === 'turn_start') {
      openTurn(ev.turn || turns.length + 1);
      curTurn.startedAt = ev.t || null;
      continue;
    }
    if (!curTurn) {
      implicitTurn += 1;
      openTurn(implicitTurn);
    }
    if (ev.type === 'turn_end') {
      curTurn.endedAt = ev.t || null;
      curTurn.reason = ev.reason;
      curTurn = null;        // 下一轮重新开
      continue;
    }

    // 一轮里面再分步：llm_start 开一个新步
    if (ev.type === 'llm_start') {
      curTurn.steps.push({
        step: curTurn.steps.length + 1,
        startedAt: ev.t || null,
        endedAt: null,
        ms: null,
        tools: [],
        retries: [],
        // v1 快照与 v2 增量分开放，最后统一合成
        reasonSnapshot: '',
        reasonDelta: '',
        /**
         * 这一步里「思考 / 说话 / 工具」的**发生顺序**。
         *
         * 为什么不能只用 reasoning + tools 两个字段：模型在一步里的输出是
         *   思考（内心戏）→ 说话（对用户的一句过渡话）→ 工具调用
         * 如果分开存成两个数组，前端渲染时只能「先全部思考、再全部工具」，
         * 中间那句过渡话就无处安放，时间线又断了。
         * 这里按事件到达顺序追加，渲染时照着铺即可。
         */
        segments: [],
      });
      continue;
    }

    // 还没开步就到工具事件（老数据）：补一个
    if (!curTurn.steps.length) {
      curTurn.steps.push({
        step: 1, startedAt: ev.t || null, endedAt: null, ms: null,
        tools: [], retries: [], reasonSnapshot: '', reasonDelta: '', segments: [],
      });
    }
    const step = curTurn.steps[curTurn.steps.length - 1];

    switch (ev.type) {
      case 'reasoning': {
        // v1 快照是累积的：取最长的那条（越长越完整），不是相加
        if (ev.text.length >= step.reasonSnapshot.length) step.reasonSnapshot = ev.text;
        break;
      }
      case 'reasoning_delta': {
        step.reasonDelta += ev.text;
        // 同一段连续思考合并成一个 segment，避免每个 8KB 切片单独成行
        const last = step.segments[step.segments.length - 1];
        if (last?.kind === 'reasoning') last.text += ev.text;
        else step.segments.push({ kind: 'reasoning', text: ev.text });
        break;
      }
      case 'text': {
        // 模型对用户说的过渡话（"我先看一下…"）。
        // 和思考一样按连续片段合并 —— 但不和思考合并，两者视觉上要分开。
        const last = step.segments[step.segments.length - 1];
        if (last?.kind === 'text') last.text += ev.text;
        else step.segments.push({ kind: 'text', text: ev.text });
        break;
      }
      case 'tool_start': {
        const tool = {
          name: ev.name, path: ev.path, ok: null, error: null, ms: null, done: false,
        };
        step.tools.push(tool);
        step.segments.push({ kind: 'tool', tool });
        break;
      }
      case 'tool_end': {
        // 尽量和前面的 tool_start 配对；配不上就单开一条（老数据没有 start）
        let hit = null;
        for (let i = step.tools.length - 1; i >= 0; i -= 1) {
          const c = step.tools[i];
          if (!c.done && c.name === ev.name && c.path === ev.path) { hit = c; break; }
        }
        if (hit) {
          hit.ok = ev.ok;
          hit.error = ev.error;
          hit.ms = ev.ms;
          hit.done = true;
        } else {
          // 只有结束事件（老数据）：补一条完整的，并让它进顺序表
          const tool = {
            name: ev.name, path: ev.path, ok: ev.ok, error: ev.error, ms: ev.ms, done: true,
          };
          step.tools.push(tool);
          step.segments.push({ kind: 'tool', tool });
        }
        break;
      }
      case 'retry': {
        step.retries.push(ev);
        step.segments.push({ kind: 'retry', retry: ev });
        break;
      }
      case 'step_end': {
        step.endedAt = ev.t || null;
        step.ms = Number.isFinite(Number(ev.ms)) ? Number(ev.ms) : null;
        break;
      }
      default:
        break;
    }
  }

  // 收尾：把两种思考文本合成一份
  for (const turn of turns) {
    for (const step of turn.steps) {
      // 增量优先（v2）；没有增量就退回快照（v1）。两者不会同时存在。
      step.reasoning = step.reasonDelta || step.reasonSnapshot || '';
      delete step.reasonDelta;
      delete step.reasonSnapshot;

      // v1 老数据只有 reasoning 快照，没走过 reasoning_delta 分支，
      // 所以 segments 里没有对应的思考段 —— 这里补一条到最前面，
      // 保证「老会话也能按顺序渲染」而不是整段思考凭空消失。
      const hasReasonSeg = (step.segments ?? []).some((s) => s.kind === 'reasoning');
      if (step.reasoning && !hasReasonSeg) {
        step.segments = [{ kind: 'reasoning', text: step.reasoning }, ...(step.segments ?? [])];
      }

      // 把这一步里「说了什么」拼成一份，给需要整段正文的地方用（存档 / 搜索）
      step.text = (step.segments ?? [])
        .filter((s) => s.kind === 'text')
        .map((s) => s.text)
        .join('');

      // segments 里引用的 tool 对象和 tools 数组是同一份引用，
      // 但 JSON 序列化后会变成两份副本 —— 前端按 segments 渲染，不重复画 tools。
      if (!Array.isArray(step.segments)) step.segments = [];
    }
    // 一轮的耗时
    if (turn.startedAt && turn.endedAt) turn.ms = turn.endedAt - turn.startedAt;
    else turn.ms = null;
  }

  // 去掉完全空白的轮（只有 turn_start 没有内容）
  const keptTurns = turns.filter(
    (t) => t.steps.some((s) => s.reasoning || s.tools.length || s.retries.length || s.text),
  );

  // ---------------------------------------------------------------
  // 2. 汇总统计
  // ---------------------------------------------------------------
  const allTools = [];
  const allRetries = [];
  for (const turn of keptTurns) {
    for (const step of turn.steps) {
      for (const t of step.tools) allTools.push({ ...t, turn: turn.turn, step: step.step });
      for (const r of step.retries) allRetries.push({ ...r, turn: turn.turn, step: step.step });
    }
  }

  const doneTools = allTools.filter((t) => t.done);
  const okTools = doneTools.filter((t) => t.ok);
  const failTools = doneTools.filter((t) => t.ok === false);

  // 「已读取文件」/「已修改文件」都是派生视图，不单独存事件 ——
  // 这样口径永远和工具调用一致，不会出现「显示读了但实际没读」的漂移。
  const filesRead = [];
  const filesChanged = [];
  const seenRead = new Set();
  const seenChanged = new Set();

  for (const t of doneTools) {
    if (!t.path) continue;
    if (t.ok && READ_TOOLS.has(t.name) && !seenRead.has(t.path)) {
      seenRead.add(t.path);
      filesRead.push({ path: t.path });
    }
    if (WRITE_TOOLS.has(t.name) && !seenChanged.has(t.path)) {
      seenChanged.add(t.path);
      filesChanged.push({ path: t.path, ok: t.ok !== false });
    }
  }

  // 「执行命令」：当前工具表里没有 shell 类工具，这里恒空。
  // 保留字段是为了前端可以「有数据才渲染」，将来接上命令工具不用改前端。
  const commands = allTools.filter((t) => /^(bash|pwsh|shell|run_command)$/.test(t.name));

  // ---------------------------------------------------------------
  // 3. family 分类视图（筛选胶囊用）
  //    口径参考 @starsea/agent-vis：message / tool / reasoning / error / file
  // ---------------------------------------------------------------
  const families = {
    message: [],
    tool: [],
    reasoning: [],
    error: [],
    file: [],
  };

  for (const turn of keptTurns) {
    for (const step of turn.steps) {
      if (step.reasoning) {
        families.reasoning.push({
          turn: turn.turn, step: step.step, chars: step.reasoning.length,
        });
      }
      // 模型在一步里说的过渡话（"我先看一下…"），归进 message 分类
      if (step.text) {
        families.message.push({
          turn: turn.turn, step: step.step, chars: step.text.length, interim: true,
        });
      }
      for (const t of step.tools) {
        const base = { turn: turn.turn, step: step.step, name: t.name, path: t.path, ok: t.ok, ms: t.ms };
        families.tool.push(base);
        if (FILE_TOOLS.has(t.name)) families.file.push(base);
        if (t.ok === false) {
          families.error.push({ ...base, error: t.error });
        }
      }
      for (const r of step.retries) {
        families.error.push({
          turn: turn.turn, step: step.step, retry: r.attempt, maxRetries: r.maxRetries,
          failure: r.failure,
        });
      }
    }
  }

  // 正文字数（来自 task.text，可能为空）
  const replyText = String(task?.text ?? '');
  if (replyText) {
    families.message.push({ chars: replyText.length });
  }

  // ---------------------------------------------------------------
  // 4. 运行态快照 + 当前动作
  // ---------------------------------------------------------------
  const running = status === 'running' || status === 'queued';
  const lastTurn = keptTurns[keptTurns.length - 1] ?? null;
  const lastStep = lastTurn?.steps[lastTurn.steps.length - 1] ?? null;

  const changedCount = okTools.filter((t) => WRITE_TOOLS.has(t.name)).length;

  return {
    // 时间线
    turns: keptTurns,

    // 分类视图
    families,

    // 派生聚合
    filesRead,
    filesChanged,
    commands,

    // 统计
    totals: {
      toolCount: allTools.length,
      okCount: okTools.length,
      failCount: failTools.length,
      retryCount: allRetries.length,
      changed: changedCount,
      ms: sumStepMs(keptTurns),
    },

    // 运行态
    status,
    running,
    eventCount: events.length,
    stepMode: keptTurns.length > 0,
    currentTurn: lastTurn?.turn ?? 0,
    currentStep: lastStep?.step ?? 0,
    completedSteps: keptTurns.flatMap((t) => t.steps.map((s) => `${t.turn}-${s.step}`)),
    finished: !running,
    currentAction: currentActionOf(keptTurns, status),
  };
}

/** 所有步骤耗时之和（没有 ms 的步不计）。 */
function sumStepMs(turns) {
  let total = 0;
  for (const turn of turns) {
    if (Number.isFinite(turn.ms)) { total += turn.ms; continue; }
    for (const step of turn.steps) {
      if (Number.isFinite(step.ms)) total += step.ms;
    }
  }
  return total;
}

/**
 * 「现在在干什么」—— 折叠状态下唯一显示的那一行。
 *
 * 有了 tool_start 之后，这里能给出**具体动作**（正在读 index.html），
 * 而不是以前千篇一律的「正在思考…」。
 */
function currentActionOf(turns, status) {
  if (status === 'queued') return '排队中…';

  const turn = turns[turns.length - 1];
  const step = turn?.steps[turn.steps.length - 1];
  if (!step) return status === 'running' ? '正在思考…' : '';

  // 有还没结束的工具 → 正在执行它
  for (let i = step.tools.length - 1; i >= 0; i -= 1) {
    const t = step.tools[i];
    if (!t.done) return `${verbOf(t.name)}${t.path ? ` ${t.path}` : ''}…`;
  }

  // 刚失败的工具
  const lastTool = step.tools[step.tools.length - 1];
  if (lastTool?.done && lastTool.ok === false) {
    return `${verbOf(lastTool.name)}${lastTool.path ? ` ${lastTool.path}` : ''}（失败）`;
  }

  if (step.retries.length) {
    const r = step.retries[step.retries.length - 1];
    return `重试中（${r.attempt}/${r.maxRetries}）`;
  }

  if (status === 'running') return '正在思考…';
  return '';
}

/** 工具的中文动词（前端渲染也用同一套口径）。 */
function verbOf(name) {
  return {
    list_files: '正在查看文件列表',
    read_file: '正在读取',
    write_file: '正在写入',
    delete_file: '正在删除',
    update_meta: '正在更新页面信息',
  }[name] ?? `正在调用 ${name}`;
}

export { FAMILIES, FILE_TOOLS, WRITE_TOOLS, READ_TOOLS };
