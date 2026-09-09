'use strict';

/**
 * 纯 JS 行级 diff 引擎。
 * 用途：
 *  1. SVN 模式：BASE 版本 vs 工作副本，自己算 unified diff（不依赖 svn diff 的格式差异）
 *  2. 快照基准模式：基准内容 vs 当前内容
 *  3. 块级“拒绝”操作：把某个 hunk 的改动从文件内容里反向替换掉（不依赖 git apply / patch）
 *
 * 策略：先裁掉公共前后缀，再对中间部分跑 Myers；规模超限时退化为整段替换。
 */

const MAX_MYERS = 8000;       // 直接跑 Myers 的 A+B 行数上限
const MAX_TRACE_BYTES = 48e6; // Myers 回溯表占用上限，超限就改用锚点分段
const MAX_ANCHOR_DEPTH = 6;   // 锚点分段的最大递归层数

/** 计算公共前后缀，返回中间区间 */
function trimCommon(a, b) {
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) { start += 1; }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return { start, endA, endB };
}

/** Myers O(ND) 求编辑脚本，返回 ['=', '-', '+'] 序列（仅针对传入切片） */
function myers(a, b) {
  const N = a.length;
  const M = b.length;
  const MAX = N + M;
  const offset = MAX;
  const size = 2 * MAX + 1;
  const V = new Int32Array(size);
  const trace = [];

  for (let d = 0; d <= MAX; d += 1) {
    if ((trace.length + 1) * size * 4 > MAX_TRACE_BYTES) { return null; }
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) {
        x = V[offset + k + 1];
      } else {
        x = V[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x += 1; y += 1; }
      V[offset + k] = x;
      if (x >= N && y >= M) {
        return backtrack(trace, a, b, offset, d);
      }
    }
  }
  return null;
}

function backtrack(trace, a, b, offset, d) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let dd = d; dd > 0; dd -= 1) {
    const V = trace[dd];
    const k = x - y;
    let prevK;
    if (k === -dd || (k !== dd && V[offset + k - 1] < V[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = V[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push('+');
      y -= 1;
    } else {
      ops.push('-');
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push('=');
    x -= 1;
    y -= 1;
  }
  while (x > 0) { ops.push('-'); x -= 1; }
  while (y > 0) { ops.push('+'); y -= 1; }
  return ops.reverse();
}

/**
 * 最长递增子序列（按 bi），用于挑出顺序一致的公共锚点。
 * @param {Array<{ai:number,bi:number}>} items 按 ai 递增
 */
function longestIncreasing(items) {
  const tails = [];
  const prev = new Array(items.length).fill(-1);
  for (let i = 0; i < items.length; i += 1) {
    const v = items[i].bi;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[tails[mid]].bi < v) { lo = mid + 1; } else { hi = mid; }
    }
    if (lo > 0) { prev[i] = tails[lo - 1]; }
    if (lo === tails.length) { tails.push(i); } else { tails[lo] = i; }
  }
  const res = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k !== -1) { res.push(items[k]); k = prev[k]; }
  res.reverse();
  return res;
}

/**
 * 找同时唯一出现在两侧的公共行作为锚点（patience diff 思路）。
 * 大文件只有局部改动时，锚点能把问题切成很小的段，避免退化成整段替换。
 */
function findAnchors(a, b) {
  const countA = new Map();
  const countB = new Map();
  for (const l of a) { countA.set(l, (countA.get(l) || 0) + 1); }
  for (const l of b) { countB.set(l, (countB.get(l) || 0) + 1); }
  const bIndex = new Map();
  for (let i = 0; i < b.length; i += 1) {
    if (countB.get(b[i]) === 1) { bIndex.set(b[i], i); }
  }
  const seq = [];
  for (let i = 0; i < a.length; i += 1) {
    const l = a[i];
    if (countA.get(l) !== 1) { continue; }
    const bi = bIndex.get(l);
    if (bi !== undefined) { seq.push({ ai: i, bi }); }
  }
  return longestIncreasing(seq);
}

/** 对去头的中间段求编辑脚本 */
function diffMiddle(a, b, depth) {
  if (!a.length && !b.length) { return []; }
  if (!a.length) { return new Array(b.length).fill('+'); }
  if (!b.length) { return new Array(a.length).fill('-'); }

  if (a.length + b.length <= MAX_MYERS) {
    const r = myers(a, b);
    if (r) { return r; }
  }

  if (depth < MAX_ANCHOR_DEPTH) {
    const anchors = findAnchors(a, b);
    if (anchors.length) {
      const ops = [];
      let ai = 0;
      let bi = 0;
      for (const an of anchors) {
        const seg = diffMiddle(a.slice(ai, an.ai), b.slice(bi, an.bi), depth + 1);
        for (const op of seg) { ops.push(op); }
        ops.push('=');
        ai = an.ai + 1;
        bi = an.bi + 1;
      }
      const tail = diffMiddle(a.slice(ai), b.slice(bi), depth + 1);
      for (const op of tail) { ops.push(op); }
      return ops;
    }
  }

  // 实在算不动：整段替换（差异会显示成一个大块，但至少不卡死）
  return new Array(a.length).fill('-').concat(new Array(b.length).fill('+'));
}

/**
 * 计算 a → b 的行级编辑脚本。
 * @returns {Array<'='|'-'|'+'>}
 */
function diffOps(a, b) {
  const { start, endA, endB } = trimCommon(a, b);
  const ops = [];
  for (let i = 0; i < start; i += 1) { ops.push('='); }
  const mid = diffMiddle(a.slice(start, endA), b.slice(start, endB), 0);
  for (const op of mid) { ops.push(op); }
  for (let i = endA; i < a.length; i += 1) { ops.push('='); }
  return ops;
}

function splitLines(text) {
  if (text === '' || text === null || text === undefined) { return []; }
  return String(text).split(/\r?\n/);
}

/**
 * 生成 unified diff 文本（git 风格头），供 diffParser 直接消费。
 * @param {string} oldText 基准内容
 * @param {string} newText 当前内容
 * @param {string} relPath 文件相对路径
 * @param {number} contextLines 上下文行数
 */
function makeUnifiedDiff(oldText, newText, relPath, contextLines = 3) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // 末尾换行会在 split 后多出一个空串，去掉以便行号与内容对齐
  const aEndsNewline = /\n$/.test(String(oldText || ''));
  const bEndsNewline = /\n$/.test(String(newText || ''));
  const la = aEndsNewline ? a.slice(0, -1) : a;
  const lb = bEndsNewline ? b.slice(0, -1) : b;

  // 末尾换行状态不同也算差异：给“无末尾换行”的最后一行加哨兵，避免被当相同行裁掉
  const cmpA = aEndsNewline || !la.length ? la : la.slice(0, -1).concat([la[la.length - 1] + '\u0000']);
  const cmpB = bEndsNewline || !lb.length ? lb : lb.slice(0, -1).concat([lb[lb.length - 1] + '\u0000']);
  const ops = diffOps(cmpA, cmpB);

  const rel = String(relPath || '').replace(/\\/g, '/');
  const header = [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`
  ];

  // 收集变更区间
  const changed = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i] !== '=') { changed.push(i); }
  }
  if (!changed.length) { return ''; }

  // 按 contextLines 合并成 hunk
  const groups = [];
  let cur = null;
  for (const idx of changed) {
    if (cur && idx - cur.last <= contextLines) {
      cur.last = idx;
    } else {
      cur = { first: idx, last: idx };
      groups.push(cur);
    }
  }

  // 计算 ops 索引 → A/B 行号
  const aIndex = new Int32Array(ops.length + 1);
  const bIndex = new Int32Array(ops.length + 1);
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    aIndex[i + 1] = aIndex[i] + (op === '+' ? 0 : 1);
    bIndex[i + 1] = bIndex[i] + (op === '-' ? 0 : 1);
  }

  const out = header.slice();
  for (const g of groups) {
    const from = Math.max(0, g.first - contextLines);
    const to = Math.min(ops.length - 1, g.last + contextLines);
    const oldStart = aIndex[from] + 1;
    const newStart = bIndex[from] + 1;
    // 一侧行数为 0 时，unified 惯例用「起始行-1」表示（新增文件: -0,0）
    let oldCount = 0;
    let newCount = 0;
    const body = [];
    const NOEOL = '\\ No newline at end of file';
    for (let i = from; i <= to; i += 1) {
      const op = ops[i];
      if (op === '=') {
        const ai = aIndex[i];
        const bi = bIndex[i];
        body.push(' ' + la[ai]);
        if (!aEndsNewline && ai === la.length - 1) { body.push(NOEOL); }
        if (!bEndsNewline && bi === lb.length - 1) { body.push(NOEOL); }
        oldCount += 1;
        newCount += 1;
      } else if (op === '-') {
        const ai = aIndex[i];
        body.push('-' + la[ai]);
        if (!aEndsNewline && ai === la.length - 1) { body.push(NOEOL); }
        oldCount += 1;
      } else {
        const bi = bIndex[i];
        body.push('+' + lb[bi]);
        if (!bEndsNewline && bi === lb.length - 1) { body.push(NOEOL); }
        newCount += 1;
      }
    }
    const oStart = oldCount === 0 ? oldStart - 1 : oldStart;
    const nStart = newCount === 0 ? newStart - 1 : newStart;
    out.push(`@@ -${oStart},${oldCount} +${nStart},${newCount} @@`);
    for (const line of body) { out.push(line); }
  }

  return out.join('\n') + '\n';
}

/** 统计 diff 的 +/- 行数（只看 +/- 开头的行，排除 --- +++ 头） */
function countFromUnified(diffText) {
  let added = 0;
  let removed = 0;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) { continue; }
    if (line.startsWith('+')) { added += 1; } else if (line.startsWith('-')) { removed += 1; }
  }
  return { added, removed };
}

/**
 * 把「当前内容」里某个 hunk 的改动撤销掉（= 拒绝这一块）。
 * 用行号区间整体替换实现，不依赖 git apply / patch，对 git / svn / 快照三种来源都适用。
 *
 * @param {string} currentText 工作区当前文件内容
 * @param {{oldStart,oldLines,newStart,newLines,lines:Array}} hunk 来自 diffParser
 * @returns {string} 新内容
 */
function revertHunkInText(currentText, hunk) {
  const raw = String(currentText == null ? '' : currentText).split('\n');
  const bare = raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const crlf = raw.filter((l) => l.endsWith('\r')).length * 2 > raw.length;

  const body = (hunk.lines || []).filter((l) => l.type !== 'meta');
  const newCount = body.filter((l) => l.type !== 'del').length;
  const oldCount = body.filter((l) => l.type !== 'add').length;
  if (hunk.newLines && newCount !== hunk.newLines) {
    throw new Error(`改动块的行数与文件对不上（块声明 ${hunk.newLines} 行，实际 ${newCount} 行），文件可能已被修改`);
  }
  const start = (hunk.newStart || 1) - 1;
  if (start < 0 || start + newCount > bare.length) {
    throw new Error('改动块的位置超出了文件范围，文件可能已被修改，请刷新后重试');
  }

  // 逐行校验：当前文件里这段必须和 diff 里记录的 new 侧完全一致
  let ni = start;
  for (const line of body) {
    if (line.type === 'del') { continue; }
    if (bare[ni] !== line.text) {
      throw new Error(
        `文件第 ${ni + 1} 行与差异内容不一致（文件可能已被手动编辑），已停止修改。\n` +
        `  文件里: ${JSON.stringify(String(bare[ni]).slice(0, 60))}\n` +
        `  差异里: ${JSON.stringify(String(line.text).slice(0, 60))}`
      );
    }
    ni += 1;
  }

  // 构造替换内容：上下文行沿用原始行（保留其换行符），删除行按文件主换行风格补
  const out = [];
  ni = start;
  for (const line of body) {
    if (line.type === 'meta') { continue; }
    if (line.type === 'ctx') {
      out.push(raw[ni]);
      ni += 1;
    } else if (line.type === 'add') {
      ni += 1; // 新增行直接丢弃
    } else {
      out.push(line.text + (crlf ? '\r' : ''));
    }
  }
  if (out.length !== oldCount) {
    throw new Error('内部错误：还原后的行数与预期不符');
  }

  raw.splice(start, newCount, ...out);
  return raw.join('\n');
}

module.exports = {
  diffOps,
  makeUnifiedDiff,
  countFromUnified,
  revertHunkInText,
  splitLines,
  trimCommon
};
