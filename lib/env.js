// 极简 .env 加载器（零依赖）。
//
// 为什么需要：模型 Key 不该硬编码进代码，也不该每次手动 export 一遍。
// 生产环境用 systemd 的 EnvironmentFile（/etc/minepage.env）注入，
// 本地开发就靠这个文件读 `.env`。
//
// 规则（故意做得简单，够用就行）：
//   - 只认 KEY=VALUE，忽略空行和 # 注释
//   - 支持单/双引号包裹（值里有空格时用）
//   - **不覆盖已存在的环境变量** —— 系统里设的优先，免得 .env 悄悄盖掉生产配置
//   - 文件不存在就静默跳过（生产环境本来就没有）
//
// 必须在 config.js 之前 import：ESM 按 import 声明顺序求值，
// server.js 把它放在第一个 import 位置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(ROOT, '..', '.env');

function parse(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // 引号包裹：去掉首尾引号，保留里面的原始字符
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let loaded = 0;
try {
  const text = fs.readFileSync(FILE, 'utf8');
  const values = parse(text);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
} catch {
  // 没有 .env 是正常情况（生产环境就是这样），不报错
}

export { FILE as ENV_FILE, loaded as envLoadedCount };
