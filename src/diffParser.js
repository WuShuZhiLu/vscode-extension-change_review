'use strict';

const crypto = require('crypto');

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function splitGitPaths(rest) {
  // rest 形如: a/src/a.js b/src/a.js  或 /dev/null b/src/a.js
  const idx = rest.indexOf(' b/');
  let oldRaw;
  let newRaw;
  if (idx === -1) {
    oldRaw = 'a/';
    newRaw = rest;
  } else {
    oldRaw = rest.slice(0, idx);
    newRaw = rest.slice(idx + 1);
  }
  const strip = (p) => {
    if (p === '/dev/null') { return '/dev/null'; }
    if (p.startsWith('a/') || p.startsWith('b/')) { return p.slice(2); }
    return p;
  };
  return { oldPath: strip(oldRaw), newPath: strip(newRaw) };
}

/**
 * 解析 unified diff 文本。
 * @returns {Array<{oldPath,newPath,isNew,isDeleted,binary,hunks:Array}>}
 * hunk: { header, oldStart, oldLines, newStart, newLines, added, removed, lines:[{type,text}] }
 */
function parseDiff(text) {
  const lines = String(text || '').split(/\r?\n/);
  // 文本以换行结尾时 split 会多出一个空串，它不是 diff 的一行，去掉
  if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
  const files = [];
  let cur = null;
  let hunk = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = splitGitPaths(line.slice('diff --git '.length));
      cur = {
        oldPath: paths.oldPath,
        newPath: paths.newPath,
        isNew: false,
        isDeleted: false,
        binary: false,
        hunks: []
      };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) { continue; }

    if (line.startsWith('new file mode')) { cur.isNew = true; continue; }
    if (line.startsWith('deleted file mode')) { cur.isDeleted = true; continue; }
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) { cur.binary = true; continue; }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') { cur.isNew = true; cur.oldPath = '/dev/null'; }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') { cur.isDeleted = true; cur.newPath = '/dev/null'; }
      continue;
    }
    if (HUNK_RE.test(line)) {
      const m = HUNK_RE.exec(line);
      hunk = {
        header: line,
        oldStart: parseInt(m[1], 10),
        oldLines: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newLines: m[4] === undefined ? 1 : parseInt(m[4], 10),
        added: 0,
        removed: 0,
        lines: []
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) { continue; }

    if (line.startsWith('\\')) {
      hunk.lines.push({ type: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      hunk.added += 1;
      hunk.lines.push({ type: 'add', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      hunk.removed += 1;
      hunk.lines.push({ type: 'del', text: line.slice(1) });
      continue;
    }
    if (line.startsWith(' ') || line === '') {
      hunk.lines.push({ type: 'ctx', text: line.slice(1) });
      continue;
    }
    // 其他头部信息行：结束当前 hunk
    hunk = null;
  }

  // 注意：不再按改动簇拆分 hunk（0.4.2 曾拆过，用户明确要求行内相近修改合并回一块，
  // 保持与 git -U3 输出一致，块级接受/拒绝以 git 的 hunk 为单位）

  return files;
}

/**
 * hunk 的内容签名：文件被改动后签名会变，用于块级“已接受”状态的持久化与失效。
 */
function hunkSignature(hunk) {
  const body = hunk.header + '\n' +
    hunk.lines.map((l) => (l.type === 'meta' ? l.text : l.type + ':' + l.text)).join('\n');
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
}

/**
 * 把一个 hunk 内部的连续改动切成「改动段」(cluster)：两段改动之间是纯上下文行。
 * 用户需要「只还原其中一段」（例如上面一处修改没问题、两行后一处纯删除要单独拒绝）时用。
 * 返回 [{ startNew, lines }]：startNew = 该段在“新文件”里的起始行号(1 基)，
 * lines 是该段内的 del/add/meta 行（不含 ctx）。
 */
function clustersOf(hunk) {
  const clusters = [];
  let cur = null;
  let p = (hunk.newStart || 1) - 1; // 0 基的新文件游标
  for (const l of (hunk.lines || [])) {
    if (l.type === 'ctx') { cur = null; p += 1; continue; }
    if (l.type === 'meta') { if (cur) { cur.lines.push(l); } continue; }
    if (!cur) { cur = { startNew: p + 1, lines: [] }; clusters.push(cur); }
    cur.lines.push(l);
    if (l.type === 'add') { p += 1; }
  }
  return clusters;
}

/** 由某个改动段合成一个可交给 revertHunkInText 的“迷你 hunk” */
function hunkForCluster(cluster) {
  const lines = cluster.lines;
  const newCount = lines.filter((l) => l.type !== 'del').length;
  const oldCount = lines.filter((l) => l.type !== 'add').length;
  return {
    header: `@@ cluster +${cluster.startNew},${newCount} @@`,
    oldStart: 1,
    oldLines: oldCount,
    newStart: cluster.startNew,
    newLines: newCount,
    added: newCount,
    removed: oldCount,
    lines
  };
}

module.exports = { parseDiff, hunkSignature, clustersOf, hunkForCluster, HUNK_RE };
