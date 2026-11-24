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
      if (!Array.isArray(step.segments)) step.segments = [];
      const hasReasonSeg = step.segments.some((s) => s.kind === 'reasoning');
      if (step.reasoning && !hasReasonSeg) {
        step.segments = [{ kind: 'reasoning', text: step.reasoning }, ...step.segments];
      }

      // 把这一步里「说了什么」拼成一份（给存档 / 搜索用）。
      // 注意用归并**前**的 segments —— 归并不会丢正文，只是改了分组。
      step.text = step.segments
        .filter((s) => s.kind === 'text')
        .map((s) => s.text)
        .join('');
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
  // 1.5 归并：把被流式推送顺序切碎的内容接回去
  //
  // 为什么需要：网关推送时，同一次模型调用里 reasoning 和 text 会**交错**到达，
  // 实测出现过 R → T → R → T（一句话被劈成两半，中间插了一段思考）：
  //     step2 [T] "…加障碍"
  //     step2 [R] 45 字
  //     step2 [T] "物、改配色、或者做成…"
  // 用户看到的是「加障碍 / 若干思考 / 物、改配色」，读起来像错字。
  //
  // 归并规则（见 mergeBlocks）：
  //   - 同一 step 内，同 kind 的相邻块合并
  //   - **工具/重试是硬边界**：`R T C R T` 会正确切成 `[R T] [C] [R T]`
  //   - 跨 step 只在「上一 step 没说完 + 中间没有工具」时接续（保守规则）
  //
  // 结果写进 turn.blocks：一条按时间排的平坦序列，前端直接照着画。
  // ---------------------------------------------------------------
  for (const turn of keptTurns) {
    turn.blocks = mergeBlocks(turn.steps);
  }

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

/**
 * 把一轮里各 step 的 segments 归并成一条平坦的 blocks 序列。
 *
 * 解决两个问题：
 *
 * ① **step 内部被切碎**（实测是主因）
 *    网关流式推送时 reasoning / text 会交错到达，同一个 step 里出现过
 *    `R → T → R → T`，把「…加障碍 / 物、改配色…」劈成两半。
 *    归并后同 kind 的相邻块合并，一句话回到完整。
 *
 * ② **step 之间偶发断裂**
 *    实测跨 step 的正文大多是完整句子（上句句号结尾、下句全新开头），
 *    所以这里用**保守规则**：只有「上一步的正文没说完 + 中间没调工具」
 *    才接续。触发条件很窄，等于一根保险丝。
 *
 * 归并的硬边界是 tool / retry —— 它们代表「模型真的做了个动作」，
 * 两侧的思考/正文不该被粘到一起。
 *
 * @param {Array} steps turn.steps
 * @returns {Array} [{ kind: 'reasoning'|'text'|'tool'|'retry', text?, tool?, retry?, step }]
 */
function mergeBlocks(steps) {
  const blocks = [];
  /** 当前正在累积的块（只有 reasoning / text 会累积） */
  let open = null;
  /** 当前块属于哪个 step —— 跨 step 接续要判断 */
  let openStep = null;
  /** 自上一段正文之后，有没有发生过工具调用（跨 step 接续的硬条件） */
  let toolSinceLastText = false;

  /**
   * 收掉当前块。
   * 顺便把它「回填」进 blocks —— 但同 step 内如果后面还有同 kind 的段，
   * 要能合并回去，所以这里用「已打开的引用」方式：open 对象push进 blocks 后
   * 仍持有引用，后面同 kind 直接改它。
   */
  const flush = () => {
    if (open) { open = null; openStep = null; }
  };

  for (const step of steps) {
    /** 这一步里已产出的块（按 kind 索引），用于把同 step 的同类段接回去 */
    const inStep = new Map();

    for (const seg of step.segments ?? []) {
      if (seg.kind === 'tool' || seg.kind === 'retry') {
        flush();
        // 工具是**硬边界**：它之前的思考/正文已经告一段落，
        // 之后再说的话属于「做完之后的新话」，不该并回前面去。
        // 所以这里清空 inStep —— 否则 `R T C R T` 会并成 `R T C`，
        // 工具之后那段正文凭空消失（实测踩到）。
        inStep.clear();
        if (seg.kind === 'tool') toolSinceLastText = true;
        blocks.push({ ...seg, step: step.step });
        continue;
      }

      // ---- 同 step 内：同类段接回同一个块 ----
      //
      // 这一步是关键。实测网关会在**同一次模型调用**里把思路和正文交错推送：
      //     reasoning → text → reasoning → text
      // 表现为「…加障碍 / 思考 / 物、改配色…」，一句话被劈成两半。
      // 既然它们同属一个 step（同一次调用），就应该各自归位：
      // 所有 text 拼成一段，所有 reasoning 拼成一段，顺序按各自**首次出现**的位置。
      const existing = inStep.get(seg.kind);
      if (existing) {
        existing.text += seg.text;
        // 保持 open 指向它，后续同类还能继续接
        open = existing;
        openStep = step.step;
        continue;
      }

      // ---- 跨 step：只有正文、且保守条件满足才接 ----
      const sameKindAcross = open && open.kind === seg.kind && openStep !== step.step;
      if (sameKindAcross && seg.kind === 'text'
        && canJoinAcrossSteps(open.text, seg.text, toolSinceLastText)) {
        open.text += seg.text;
        openStep = step.step;
        inStep.set(seg.kind, open);
        continue;
      }

      // ---- 新块 ----
      const block = { kind: seg.kind, text: seg.text, step: step.step };
      blocks.push(block);
      inStep.set(seg.kind, block);
      open = block;
      openStep = step.step;
      if (seg.kind === 'text') toolSinceLastText = false;
    }

    // 一步结束：**不清空 open**。
    // 跨 step 接续（"上句没说完 + 中间没工具 → 接上"）需要它，
    // 清空的话那条规则永远不会触发。
    // `openStep` 还留着上一个 step 的号，正好用来判断「是否跨了 step」。
  }

  return blocks;
}

/**
 * 跨 step 的正文能不能接成一段。
 *
 * 保守规则（三个条件全满足才接）：
 *   1. 上一段没有以句末标点/换行结尾 —— 说明话还没说完
 *   2. 这两段之间没有发生工具调用 —— 有工具就是两个独立动作
 *   3. 下一段不是以明显的「新段落」开头（比如「做好了」「改好了」这种收尾语）
 *
 * 按实测数据，绝大多数跨 step 边界都是完整句子，所以这里几乎不会触发。
 * 它的作用是兜住偶发的「半句话被 step 边界切开」。
 */
function canJoinAcrossSteps(prevTail, nextHead, toolSinceLastText) {
  if (toolSinceLastText) return false;
  const prev = String(prevTail ?? '').trimEnd();
  const next = String(nextHead ?? '').trimStart();
  if (!prev || !next) return false;

  // 条件 1：上一段已经说完了 → 不该接
  if (/[。！？；.!?;\n]$/.test(prev)) return false;

  // 条件 3：下一段是「收尾语/新段落」 → 不该接
  if (/^(做好了|改好了|完成了|搞定了|已经|现在|另外|接下来|最后|总之)/.test(next)) return false;

  return true;
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
