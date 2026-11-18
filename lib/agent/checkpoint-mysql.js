// LangGraph 的 MySQL CheckpointSaver。
//
// 为什么自己写：官方 npm 生态里没有 MySQL 版（只有 postgres / sqlite / redis /
// mongodb）。Python 那边有个 langgraph-checkpoint-mysql 的第三方包，但它是
// py3-none-any 的 Python wheel，Node 项目装不了。
// 所以这里继承 @langchain/langgraph-checkpoint 的 BaseCheckpointSaver，
// 参照官方 MemorySaver 的语义，把存储换成 MySQL。
//
// 四个必须实现的方法（签名见 base.d.ts）：
//   getTuple(config)                     读一个检查点 + 它的 pending writes
//   list(config, options)                按 thread 列检查点（新到旧）
//   put(config, checkpoint, metadata)    写一个检查点
//   putWrites(config, writes, taskId)    写某个任务的中间产物
//   deleteThread(threadId)               删掉一个会话的全部数据
//
// 序列化统一交给 JsonPlusSerializer（LangGraph 自带）：
//   dumpsTyped(obj) → [type, Uint8Array]
//   loadsTyped(type, data) → obj
// 它能把消息对象、Map、Set、二进制等还原回来，比裸 JSON 稳得多。
//
// 表结构见 lib/db.js 的 agent_checkpoints / agent_checkpoint_writes。

import { BaseCheckpointSaver, JsonPlusSerializer, WRITES_IDX_MAP, compareWritesSortKeys } from '@langchain/langgraph-checkpoint';
import { all, get, run } from '../db.js';

/** 把 Uint8Array 和 type 一起塞进 TEXT 列：`<type>\n<base64>`。 */
function pack(type, bytes) {
  return `${type}\n${Buffer.from(bytes).toString('base64')}`;
}

/** 拆回 [type, Uint8Array]。 */
function unpack(packed) {
  const s = String(packed ?? '');
  const nl = s.indexOf('\n');
  if (nl < 0) return ['json', new Uint8Array()];
  return [s.slice(0, nl), new Uint8Array(Buffer.from(s.slice(nl + 1), 'base64'))];
}

/** LangGraph 的 config 里放的是 thread_id / checkpoint_ns / checkpoint_id。 */
function configurableOf(config) {
  return config?.configurable ?? {};
}

function requireThreadId(config, where) {
  const threadId = configurableOf(config).thread_id;
  if (threadId === undefined) {
    throw new Error(`Failed to ${where}. config.configurable.thread_id is required.`);
  }
  // 和 MemorySaver 一样防原型污染：这些值会进 SQL，虽然参数化了，
  // 但空串或 __proto__ 这类值进来本身说明调用方接线错了。
  const s = String(threadId);
  if (!s) throw new Error(`Invalid thread_id: empty string is not permitted.`);
  if (s === '__proto__' || s === 'constructor' || s === 'prototype') {
    throw new Error(`Invalid thread_id: "${s}" is reserved.`);
  }
  return s;
}

/**
 * 从数据库行还原成 LangGraph 的 Checkpoint。
 * channel_values 里存的是各个已序列化的值，要逐个 loadsTyped 还原。
 */
async function rowToCheckpointTuple(serde, row, writes) {
  const [checkpointType, checkpointBytes] = unpack(row.checkpoint);
  const [metadataType, metadataBytes] = unpack(row.metadata);

  const checkpoint = await serde.loadsTyped(checkpointType, checkpointBytes);
  const metadata = await serde.loadsTyped(metadataType, metadataBytes);

  const config = {
    configurable: {
      thread_id: row.thread_id,
      checkpoint_ns: row.checkpoint_ns,
      checkpoint_id: row.checkpoint_id,
    },
  };

  const tuple = { config, checkpoint, metadata };

  if (row.parent_id) {
    tuple.parentConfig = {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.parent_id,
      },
    };
  }

  if (writes && writes.length) {
    tuple.pendingWrites = await Promise.all(writes.map(async (w) => {
      const [type, bytes] = unpack(w.value);
      return [w.task_id, w.channel, await serde.loadsTyped(type, bytes), w.task_path ?? ''];
    }));
  }

  return tuple;
}

export class MySqlSaver extends BaseCheckpointSaver {
  constructor(serde) {
    super(serde ?? new JsonPlusSerializer());
  }

  /** 读一个检查点。config 里给 checkpoint_id 就读指定那版，否则读最新的。 */
  async getTuple(config) {
    const c = configurableOf(config);
    const threadId = requireThreadId(config, 'get checkpoint');
    const ns = c.checkpoint_ns ?? '';
    const checkpointId = c.checkpoint_id;

    const row = checkpointId
      ? await get(
        `SELECT * FROM agent_checkpoints
          WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        threadId, ns, checkpointId,
      )
      : await get(
        `SELECT * FROM agent_checkpoints
          WHERE thread_id = ? AND checkpoint_ns = ?
          ORDER BY checkpoint_id DESC LIMIT 1`,
        threadId, ns,
      );

    if (!row) return undefined;

    const writes = await all(
      `SELECT * FROM agent_checkpoint_writes
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
      threadId, ns, row.checkpoint_id,
    );
    // 按 writesSortKey 排序：taskPath → taskId → idx。
    // 顺序错了，对顺序敏感的 reducer 重建出来的值会和运行时不一致。
    writes.sort((a, b) => compareWritesSortKeys(
      [a.task_path ?? '', a.task_id, Number(a.idx)],
      [b.task_path ?? '', b.task_id, Number(b.idx)],
    ));

    return rowToCheckpointTuple(this.serde, row, writes);
  }

  /**
   * 列检查点。给了 config.checkpoint_id 就从那个点往回列，否则从最新开始。
   * LangGraph 用它做时间旅行和「从某点重放」，所以要严格新到旧。
   */
  async *list(config, options = {}) {
    const c = configurableOf(config);
    const threadId = requireThreadId(config, 'list checkpoints');
    const ns = c.checkpoint_ns ?? '';

    const limit = Number(options.limit);
    const hasLimit = Number.isFinite(limit) && limit > 0;
    const before = options.before?.configurable?.checkpoint_id;

    // checkpoint_id 是 uuid6，字典序即时间序，所以能用字符串比较做「早于」
    const where = ['thread_id = ?', 'checkpoint_ns = ?'];
    const params = [threadId, ns];
    if (before) { where.push('checkpoint_id < ?'); params.push(before); }

    const sql = `SELECT * FROM agent_checkpoints
                  WHERE ${where.join(' AND ')}
                  ORDER BY checkpoint_id DESC
                  ${hasLimit ? 'LIMIT ?' : ''}`;
    const rows = await all(sql, ...params, ...(hasLimit ? [limit] : []));

    for (const row of rows) {
      const writes = await all(
        `SELECT * FROM agent_checkpoint_writes
          WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        threadId, ns, row.checkpoint_id,
      );
      writes.sort((a, b) => compareWritesSortKeys(
        [a.task_path ?? '', a.task_id, Number(a.idx)],
        [b.task_path ?? '', b.task_id, Number(b.idx)],
      ));
      yield await rowToCheckpointTuple(this.serde, row, writes);
    }
  }

  /** 写一个检查点。同一个 (thread, ns, id) 重复写时覆盖。 */
  async put(config, checkpoint, metadata) {
    const c = configurableOf(config);
    const threadId = requireThreadId(config, 'put checkpoint');
    const ns = c.checkpoint_ns ?? '';

    const [[checkpointType, checkpointBytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata ?? {}),
    ]);

    await run(
      `INSERT INTO agent_checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         parent_id = VALUES(parent_id),
         type = VALUES(type),
         checkpoint = VALUES(checkpoint),
         metadata = VALUES(metadata)`,
      threadId,
      ns,
      checkpoint.id,
      c.checkpoint_id ?? null,
      checkpointType,
      pack(checkpointType, checkpointBytes),
      pack(metadataType, metadataBytes),
      new Date().toISOString(),
    );

    return {
      configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    };
  }

  /**
   * 写某个任务的中间产物。
   *
   * WRITES_IDX_MAP 里是「特殊 channel」的固定下标（RESUME / ERROR 这类），
   * 它们的 idx 必须用固定值，普通 channel 用数组下标。
   * 重复写入同一个 (task, idx) 时覆盖 —— 但特殊 channel 不覆盖，
   * 这是 MemorySaver 的既有语义。
   */
  async putWrites(config, writes, taskId, taskPath = '') {
    const c = configurableOf(config);
    const threadId = requireThreadId(config, 'put writes');
    const ns = c.checkpoint_ns ?? '';
    const checkpointId = c.checkpoint_id;
    if (checkpointId === undefined) {
      throw new Error('Failed to put writes. config.configurable.checkpoint_id is required.');
    }

    for (const [idx, write] of writes.entries()) {
      const channel = write[0];
      const value = write[1];
      const [type, bytes] = await this.serde.dumpsTyped(value);
      // 特殊 channel 用固定 idx，普通 channel 用当前下标
      const finalIdx = WRITES_IDX_MAP[channel] !== undefined ? WRITES_IDX_MAP[channel] : idx;
      const isSpecial = WRITES_IDX_MAP[channel] !== undefined;

      const sql = isSpecial
        // 特殊 channel 已存在就跳过（IGNORE）
        ? `INSERT IGNORE INTO agent_checkpoint_writes
             (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        // 普通 channel 覆盖
        : `INSERT INTO agent_checkpoint_writes
             (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE type = VALUES(type), value = VALUES(value)`;

      await run(
        sql,
        threadId, ns, checkpointId, String(taskId), String(taskPath ?? ''),
        finalIdx, channel, type, pack(type, bytes), new Date().toISOString(),
      );
    }
  }

  /**
   * 删掉一个会话的全部检查点和中间产物。
   *
   * 走一次事务：主表和 writes 表要一起清，否则 writes 会变成孤儿行。
   */
  async deleteThread(threadId) {
    const id = String(threadId);
    if (!id) throw new Error('Invalid thread_id: empty string is not permitted.');

    await run('DELETE FROM agent_checkpoint_writes WHERE thread_id = ?', id);
    await run('DELETE FROM agent_checkpoints WHERE thread_id = ?', id);
  }
}

export default MySqlSaver;
