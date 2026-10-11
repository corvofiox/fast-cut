'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  EXPORT_CONTAINERS, byId, byExt, familyOfExt, familyOfFormat, unmuxableSubtitles,
} = require('./containers');

test('可导出的容器白名单只有实测验证过的两个家族', () => {
  assert.deepStrictEqual(EXPORT_CONTAINERS.map((c) => c.id), ['mp4', 'm4v', 'mov', 'mkv']);
  assert.strictEqual(byId('avi'), null);        // 源可以是 avi，但不提供为导出目标
  assert.strictEqual(byId('webm'), null);       // 同上：H.264 装不进 webm
});

test('id 与扩展名两种写法都能认，大小写无关', () => {
  assert.strictEqual(byId('MKV').ext, '.mkv');
  assert.strictEqual(byExt('.MP4').family, 'mov');
  assert.strictEqual(byExt('mkv').family, 'matroska');
  assert.strictEqual(familyOfExt('.ts'), null);
  assert.strictEqual(familyOfExt(''), null);
});

test('ffprobe 的 format_name 是逗号串，按家族归类', () => {
  assert.strictEqual(familyOfFormat('mov,mp4,m4a,3gp,3g2,mj2'), 'mov');
  assert.strictEqual(familyOfFormat('matroska,webm'), 'matroska');
  assert.strictEqual(familyOfFormat('avi'), null);
  assert.strictEqual(familyOfFormat(null), null);
});

test('mov/mp4 装不下 subrip / ass / PGS，mkv 全收', () => {
  assert.deepStrictEqual(unmuxableSubtitles('mov', ['subrip', 'ass', 'hdmv_pgo_subtitle']),
    ['subrip', 'ass', 'hdmv_pgo_subtitle']);
  assert.deepStrictEqual(unmuxableSubtitles('mov', ['mov_text', 'webvtt']), []);
  assert.deepStrictEqual(unmuxableSubtitles('matroska', ['subrip', 'ass']), []);
  assert.deepStrictEqual(unmuxableSubtitles(null, ['subrip']), []);   // 跟随源：不改映射
  assert.deepStrictEqual(unmuxableSubtitles('mov', []), []);
});
