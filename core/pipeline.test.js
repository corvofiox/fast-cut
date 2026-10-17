'use strict';

/**
 * 导出落盘相关的回归（2026-10-17，一次真实失败催出来的）：
 * 用户切 4 小时 / 27GB 的 mkv（AV1），输出盘（E:）剩 230GB，
 * 却在导出时报 `No space left on device`——因为中间文件写在**系统临时盘**，
 * 而预检只看了输出盘。
 */
const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { precheckSpace, makeTempDir } = require('./pipeline');
const { explainExit } = require('./probe');

/** 造一个临时目录，测完删掉 */
async function withTempDir(fn) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-pipe-test-'));
  try {
    return await fn(base);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
}

test('空间预检把"工作副本 + 中间段 + 产物"都算进去（同卷要三份并存）', async () => {
  // 8 Mbps → (1_000_000/8)*1.05 = 131250 B/s，取整方便核对
  const media = { bitRate: 1_000_000 };
  const opts = { keepSecs: 100, workSecs: 200, tmpBase: null };
  const r = await precheckSpace(path.join(os.tmpdir(), 'fc-x.mp4'), media, opts);
  // 产物 13,125,000 +（工作副本 26,250,000 + 中间段 13,125,000）= 52,500,000
  assert.strictEqual(r.bytesNeeded, 52_500_000);

  // 没有归一（workSecs=0）时只剩"中间段 + 产物"
  const r2 = await precheckSpace(path.join(os.tmpdir(), 'fc-x.mp4'), media,
    { keepSecs: 100, workSecs: 0 });
  assert.strictEqual(r2.bytesNeeded, 26_250_000);

  // 老实现只按产物一个文件估（13,125,000）——这正是它漏掉工作副本的地方
  assert.ok(r.bytesNeeded > 13_125_000 * 2, '必须显著大于"只估产物一份"');
});

test('临时目录与产物同卷/异卷：需求分摊到各自的盘，总量一致', async () => {
  const media = { bitRate: 1_000_000 };
  const same = await precheckSpace(path.join(os.tmpdir(), 'fc-x.mp4'), media,
    { keepSecs: 100, workSecs: 200, tmpBase: os.tmpdir() });
  const diff = await precheckSpace(path.join(os.tmpdir(), 'fc-x.mp4'), media,
    { keepSecs: 100, workSecs: 200, tmpBase: path.join(os.tmpdir(), 'fc-other') });
  // 同卷：产物 + （工作副本 + 中间段）；异卷：两个目录各摊一份。总量必须相等
  assert.strictEqual(same.bytesNeeded, diff.bytesNeeded);
  assert.strictEqual(same.bytesNeeded, 52_500_000);
});

test('空间不够时：报出**具体哪个目录**不够，并给可执行建议', async () => {
  // 位率给到 1Tbps，任何盘的可用空间都不够
  const r = await precheckSpace(path.join(os.tmpdir(), 'fc-x.mp4'), { bitRate: 1e12 },
    { keepSecs: 3600, workSecs: 3600 });
  assert.strictEqual(r.ok, false);
  assert.ok(/磁盘空间不足/.test(r.message), r.message);
  assert.ok(r.message.includes(path.dirname(path.join(os.tmpdir(), 'fc-x.mp4').replace(/\\/g, path.sep)))
    || r.message.includes(path.dirname(path.resolve(path.join(os.tmpdir(), 'fc-x.mp4')))),
  `消息里要出现目录名：${r.message}`);
  assert.ok(/输出目录/.test(r.message), '要给"换目录/清盘"的建议');
});

test('空间充足时放行（别把正常导出误拦）', async () => {
  const r = await precheckSpace(path.join(os.tmpdir(), 'fc-x.mp4'), { bitRate: 1 },
    { keepSecs: 1, workSecs: 1 });
  assert.strictEqual(r.ok, true);
});

test('中间文件目录落在**输出文件同一卷**（不再写系统临时盘）', async () => {
  await withTempDir(async (base) => {
    const out = path.join(base, 'out.mp4');
    const dir = await makeTempDir(out);
    assert.strictEqual(path.resolve(path.dirname(dir)), path.resolve(base),
      `中间目录必须与产物同目录：${dir}`);
    assert.ok(path.basename(dir).startsWith('.fast-cut-tmp-'), path.basename(dir));
    const st = await fsp.stat(dir);
    assert.ok(st.isDirectory());
  });
});

test('ffmpeg 的 -28 翻成人话（Windows 上是无符号 4294967268）', () => {
  const s = 'muxer: No space left on device';
  assert.ok(/磁盘空间不足/.test(explainExit(-28, s)));
  assert.ok(/磁盘空间不足/.test(explainExit(4294967268, s)),
    'Node 在 Windows 给的是无符号退出码，也要认出来');
  assert.ok(/磁盘空间不足/.test(explainExit(1, 'Error writing trailer: No space left on device')));
  assert.ok(/权限/.test(explainExit(1, 'Permission denied')));
  assert.strictEqual(explainExit(1, 'something else entirely'), '', '认不出来就别乱猜');
});
