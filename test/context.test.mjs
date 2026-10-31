import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextBuilder, fitTexts, truncateAtBoundary } from '../dist/context.js';
import { assertNoRemovedFields } from '../dist/config.js';
import { buildReviewMetadata } from '../dist/summary.js';

const block = (text) => `<!-- AI_REVIEW_INSTRUCTIONS_START\n${text}\nAI_REVIEW_INSTRUCTIONS_END -->`;

function pr(body, extra = {}) {
  return {
    title: 'T',
    body,
    labels: ['bug'],
    files: [{ filename: 'src/a.kt', status: 'modified', patch: '+code line', contents: undefined }],
    ...extra,
  };
}

function builder(options = {}, include = {}) {
  return new ContextBuilder(
    {},
    include.title ?? true,
    include.body ?? true,
    include.labels ?? true,
    options,
  );
}

test('long body (>=500 chars) is sent up to the limit, not dropped', () => {
  const body = 'a'.repeat(800);
  const r = builder({ maxPrBodyChars: 10_000 }).buildPrompt(pr(body), 5_000);
  assert.ok(r.prompt.includes(body));
  assert.equal(r.usage.prBody, 'full');
});

test('body over max_pr_body_chars is partially included', () => {
  const body = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const r = builder({ maxPrBodyChars: 200 }).buildPrompt(pr(body));
  assert.equal(r.usage.prBody, 'partial');
  assert.ok(r.prompt.includes('line 0'));
  assert.ok(!r.prompt.includes('line 99'));
  assert.ok(r.prompt.includes('省略'));
});

test('instructions are extracted before body truncation and not duplicated', () => {
  const body = 'x'.repeat(5_000) + '\n' + block('末尾の指示XYZ');
  const r = builder({ maxPrBodyChars: 100 }).buildPrompt(pr(body));
  assert.equal(r.usage.prInstructions, 'full');
  assert.equal(r.prompt.split('末尾の指示XYZ').length - 1, 1);
  assert.ok(!r.prompt.includes('AI_REVIEW_INSTRUCTIONS_START'));
});

test('include_pr_body=false sends no body-derived info', () => {
  const r = builder({}, { body: false }).buildPrompt(pr(`本文ABC\n${block('指示DEF')}`));
  assert.ok(!r.prompt.includes('本文ABC'));
  assert.ok(!r.prompt.includes('指示DEF'));
  assert.equal(r.usage.prInstructions, 'excluded_by_config');
  assert.equal(r.usage.prBody, 'excluded_by_config');
});

test('no instruction / empty block => none', () => {
  assert.equal(builder().buildPrompt(pr('plain')).usage.prInstructions, 'none');
  assert.equal(builder().buildPrompt(pr(block(''))).usage.prInstructions, 'none');
});

test('malformed block => malformed status, content stays in body', () => {
  const r = builder().buildPrompt(pr('<!-- AI_REVIEW_INSTRUCTIONS_START\nkept as body'));
  assert.equal(r.usage.prInstructions, 'malformed');
  assert.ok(r.usage.prInstructionsMalformed);
  assert.ok(r.prompt.includes('kept as body'));
});

test('project context and instructions are placed in separate sections', () => {
  const r = builder({ projectContext: 'CTX' }).buildPrompt(pr(block('PRI')));
  assert.match(r.prompt, /# 案件固有情報[\s\S]*CTX/);
  assert.match(r.prompt, /# 今回のPRに対する追加指示[\s\S]*PRI/);
});

test('global budget: body is reduced first, code and priority texts are kept', () => {
  const r = builder({ projectContext: 'CTX', maxPrBodyChars: 100_000 }).buildPrompt(
    pr('b'.repeat(60_000)),
    3_000,
  );
  assert.equal(r.usage.projectContext, 'full');
  assert.ok(r.prompt.includes('+code line'));
  assert.ok(['partial', 'omitted_budget'].includes(r.usage.prBody));
  assert.ok(r.prompt.length / 3.5 < 3_000);
});

test('huge instructions cannot push out all code; both texts are shortened fairly', () => {
  const r = builder({ projectContext: 'c'.repeat(40_000) }).buildPrompt(
    pr(block('i'.repeat(40_000))),
    4_000,
  );
  assert.equal(r.usage.projectContext, 'partial');
  assert.equal(r.usage.prInstructions, 'partial');
  assert.ok(r.prompt.includes('+code line'));
  assert.ok(r.prompt.includes('c'.repeat(100)) && r.prompt.includes('i'.repeat(100)));
});

test('too small max_input_tokens => insufficient', () => {
  const r = builder().buildPrompt(pr('x'), 100);
  assert.ok(r.insufficient);
});

test('truncateAtBoundary prefers line boundaries', () => {
  const text = 'aaaa\nbbbb\ncccc\ndddd\neeee\nffff\ngggg\nhhhh\niiii';
  const r = truncateAtBoundary(text.repeat(3).replace(/iiii/g, 'iiii\n'), 60);
  assert.ok(r.truncated);
  const kept = r.text.split('\n…')[0];
  assert.ok(kept.split('\n').every((l) => /^[a-i]{4}$/.test(l)), kept);
});

test('fitTexts keeps a share for each non-empty text', () => {
  const r = fitTexts({ a: 'x'.repeat(10_000), b: 'y'.repeat(100) }, 1_000);
  assert.ok(r.b.text.length > 0);
  assert.ok(r.a.text.length > 0 && r.a.truncated);
});

test('removed legacy settings stop with a migration message', () => {
  assert.throws(
    () => assertNoRemovedFields({ project_context: 'x', reviewer_role: 'R', additional_rules: 'A' }),
    /reviewer_role.*project_context.*additional_rules.*AI_REVIEW_INSTRUCTIONS/s,
  );
  assert.doesNotThrow(() => assertNoRemovedFields({ project_context: 'x' }));
  assert.doesNotThrow(() => assertNoRemovedFields(null));
});

test('metadata display reflects actual usage', () => {
  const base = { projectContext: 'full', prInstructions: 'partial', prInstructionsMalformed: false, prBody: 'partial', metadataDropped: false };
  const text = buildReviewMetadata({ runStatus: 'verified', usage: base });
  assert.match(text, /検証付きレビュー（2段階完了）/);
  assert.match(text, /案件固有情報：反映済み/);
  assert.match(text, /PR 本文の AI レビュー指示：一部反映（入力上限により省略あり）/);
  assert.match(text, /PR 本文は文字数または入力上限により一部を省略/);

  const failed = buildReviewMetadata({ runStatus: 'verification_failed', usage: { ...base, prInstructions: 'excluded_by_config' } });
  assert.match(failed, /検証未完了/);
  assert.match(failed, /未反映（設定により除外）/);
});
