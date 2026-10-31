import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIService, VerificationError } from '../dist/openai.js';
import { runReview } from '../dist/review-runner.js';

function createConfig(overrides = {}) {
  return {
    reviewMode: 'verified',
    openaiApiKey: 'k',
    openaiModel: 'm',
    githubToken: 't',
    reviewerRole: 'r',
    techStack: 'ts',
    reviewFocus: 'bugs',
    commentLanguage: 'ja',
    filePriorities: {},
    excludePatterns: [],
    includePrTitle: true,
    includePrBody: true,
    includePrLabels: true,
    ...overrides,
  };
}

const draftText = [
  '**SUMMARY_START**', '下書き概要', '**SUMMARY_END**',
  '**COMMENTS_START**',
  'a.ts:1', '[critical]', '誤指摘A',
  '', 'b.ts:2', '[style]', '説明が悪いB',
  '', 'c.ts:3', '[performance]', '妥当C',
  '**COMMENTS_END**',
].join('\n');

const resp = (text, usage = [10, 5], extra = {}) => ({
  ok: true,
  async json() {
    return {
      output_text: text,
      status: 'completed',
      usage: { input_tokens: usage[0], output_tokens: usage[1], total_tokens: usage[0] + usage[1] },
      ...extra,
    };
  },
  async text() { return ''; },
});

function makeService(responses, overrides) {
  const calls = [];
  const service = new OpenAIService(createConfig(overrides), async (url, options) => {
    calls.push(JSON.parse(options.body));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { service, calls };
}

const verdict = (decisions, summary = '最終概要') => JSON.stringify({ summary, decisions });

test('verified: keep/revise/drop are reflected, internal reasons are not leaked', async () => {
  const { service, calls } = makeService([
    resp(draftText, [100, 50]),
    resp(verdict([
      { id: 'C1', verdict: 'drop', reason: 'SECRET_REASON' },
      { id: 'C2', verdict: 'revise', reason: 'x', revised: { path: 'b.ts', line: 4, tag: 'critical', message: '修正B' } },
      { id: 'C3', verdict: 'keep' },
    ]), [200, 20]),
  ]);

  const outcome = await runReview({ reviewMode: 'verified' }, service, 'PROMPT');
  assert.equal(outcome.status, 'verified');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].store, false);
  assert.match(calls[1].input[1].content[0].text, /PROMPT/);
  assert.match(calls[1].input[1].content[0].text, /"id": "C1"/);
  assert.equal(outcome.review.summary, '最終概要');
  assert.deepEqual(outcome.review.lineComments, [
    { path: 'b.ts', line: 4, tag: 'critical', message: '修正B' },
    { path: 'c.ts', line: 3, tag: 'performance', message: '妥当C' },
  ]);
  const posted = JSON.stringify(outcome.review);
  assert.ok(!posted.includes('SECRET_REASON'));
  assert.ok(!posted.includes('誤指摘A'));
  assert.deepEqual(outcome.review.tokenUsage, { promptTokens: 300, completionTokens: 70, totalTokens: 370 });
});

test('single: only one API call and no verification', async () => {
  const { service, calls } = makeService([resp(draftText)]);
  const outcome = await runReview({ reviewMode: 'single' }, service, 'P');
  assert.equal(outcome.status, 'single');
  assert.equal(calls.length, 1);
  assert.equal(outcome.review.lineComments.length, 3);
});

test('verified: zero candidates still verifies the summary', async () => {
  const draft = '**SUMMARY_START**\n問題なし\n**SUMMARY_END**\n**COMMENTS_START**\n**COMMENTS_END**';
  const { service, calls } = makeService([resp(draft), resp(verdict([], '検証後概要'))]);
  const outcome = await runReview({ reviewMode: 'verified' }, service, 'P');
  assert.equal(calls.length, 2);
  assert.equal(outcome.status, 'verified');
  assert.equal(outcome.review.summary, '検証後概要');
  assert.deepEqual(outcome.review.lineComments, []);
});

const failureCases = {
  'unknown id': verdict([{ id: 'C9', verdict: 'keep' }]),
  'duplicate id': verdict([{ id: 'C1', verdict: 'keep' }, { id: 'C1', verdict: 'keep' }, { id: 'C2', verdict: 'keep' }, { id: 'C3', verdict: 'keep' }]),
  'missing decision': verdict([{ id: 'C1', verdict: 'drop' }, { id: 'C2', verdict: 'drop' }]),
  'revise without revised': verdict([{ id: 'C1', verdict: 'revise' }, { id: 'C2', verdict: 'keep' }, { id: 'C3', verdict: 'keep' }]),
  'invalid revised': verdict([{ id: 'C1', verdict: 'revise', revised: { path: 'a.ts', line: 0, tag: 'bad', message: '' } }, { id: 'C2', verdict: 'keep' }, { id: 'C3', verdict: 'keep' }]),
  'not json': '問題ありません',
  'truncated json': '{"summary":"x","decisions":[',
};

for (const [name, text] of Object.entries(failureCases)) {
  test(`verified: ${name} => verification_failed, nothing posted as OK`, async () => {
    const { service } = makeService([resp(draftText, [1, 1]), resp(text, [2, 2])]);
    const outcome = await runReview({ reviewMode: 'verified' }, service, 'P');
    assert.equal(outcome.status, 'verification_failed');
    assert.deepEqual(outcome.review.lineComments, []);
    assert.equal(outcome.review.tokenUsage.totalTokens, 6);
  });
}

test('verified: incomplete response is verification_failed', async () => {
  const { service } = makeService([
    resp(draftText),
    resp(verdict([]), [1, 1], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
  ]);
  const outcome = await runReview({ reviewMode: 'verified' }, service, 'P');
  assert.equal(outcome.status, 'verification_failed');
});

test('verified: verification API error is verification_failed, first-stage usage kept', async () => {
  const { service } = makeService([
    resp(draftText, [7, 3]),
    { ok: false, status: 500, async text() { return 'boom'; } },
  ]);
  const outcome = await runReview({ reviewMode: 'verified' }, service, 'P');
  assert.equal(outcome.status, 'verification_failed');
  assert.match(outcome.reason, /500/);
  assert.equal(outcome.review.tokenUsage.totalTokens, 10);
});

test('verified: candidates exceeding input budget => verification_failed without 2nd call', async () => {
  const { service, calls } = makeService([resp(draftText)]);
  const outcome = await runReview({ reviewMode: 'verified', maxInputTokens: 10 }, service, 'P');
  assert.equal(outcome.status, 'verification_failed');
  assert.equal(calls.length, 1);
});

test('first-stage API failure still throws (existing behavior)', async () => {
  const { service } = makeService([{ ok: false, status: 429, async text() { return 'rl'; } }]);
  await assert.rejects(() => runReview({ reviewMode: 'verified' }, service, 'P'), /429/);
});

test('VerificationError carries usage', () => {
  const e = new VerificationError('x', { promptTokens: 1, completionTokens: 1, totalTokens: 2 });
  assert.equal(e.tokenUsage.totalTokens, 2);
});
