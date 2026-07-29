import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIService } from '../dist/openai.js';

function createConfig(overrides = {}) {
  return {
    openaiApiKey: 'test-key',
    openaiModel: 'gpt-5.3-codex',
    githubToken: 'test-gh-token',
    reviewerRole: 'レビュー担当',
    techStack: 'TypeScript',
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

test('generateReview reads Responses API output_text and usage', async () => {
  const calls = [];
  const service = new OpenAIService(
    createConfig({ maxOutputTokens: 128 }),
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            output_text: [
              '**SUMMARY_START**',
              '全体として問題ありません。',
              '**SUMMARY_END**',
              '**COMMENTS_START**',
              'src/main.ts:12',
              '[critical]',
              '確実に壊れる処理です。',
              '**COMMENTS_END**',
            ].join('\n'),
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              total_tokens: 30,
            },
            status: 'completed',
          };
        },
        async text() {
          return '';
        },
      };
    },
  );

  const result = await service.generateReview('review prompt');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(JSON.parse(calls[0].options.body).store, false);
  assert.equal(JSON.parse(calls[0].options.body).max_output_tokens, 128);
  assert.equal(result.model, 'gpt-5.3-codex');
  assert.equal(result.summary, '全体として問題ありません。');
  assert.deepEqual(result.lineComments, [
    {
      path: 'src/main.ts',
      line: 12,
      tag: 'critical',
      message: '確実に壊れる処理です。',
    },
  ]);
  assert.deepEqual(result.tokenUsage, {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
  });
});

test('generateReview extracts text from Responses API output items', async () => {
  const service = new OpenAIService(
    createConfig(),
    async () => ({
      ok: true,
      async json() {
        return {
          output: [
            {
              content: [
                {
                  text: [
                    '**SUMMARY_START**',
                    '要約です。',
                    '**SUMMARY_END**',
                    '**COMMENTS_START**',
                    'src/app.ts:1',
                    '[style]',
                    '表記ゆれがあります。',
                    '**COMMENTS_END**',
                  ].join('\n'),
                },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
          },
          status: 'completed',
        };
      },
      async text() {
        return '';
      },
    }),
  );

  const result = await service.generateReview('review prompt');

  assert.equal(result.summary, '要約です。');
  assert.equal(result.lineComments[0].tag, 'style');
  assert.equal(result.tokenUsage.totalTokens, 3);
});

test('generateReview throws on non-2xx responses', async () => {
  const service = new OpenAIService(
    createConfig(),
    async () => ({
      ok: false,
      status: 429,
      async text() {
        return 'rate limited';
      },
    }),
  );

  await assert.rejects(
    () => service.generateReview('review prompt'),
    /OpenAI APIエラー: 429 - rate limited/,
  );
});

test('generateReview throws when Responses API returns incomplete content without text', async () => {
  const service = new OpenAIService(
    createConfig({ maxOutputTokens: 8 }),
    async () => ({
      ok: true,
      async json() {
        return {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: {
            input_tokens: 4,
            output_tokens: 8,
            total_tokens: 12,
          },
        };
      },
      async text() {
        return '';
      },
    }),
  );

  await assert.rejects(
    () => service.generateReview('review prompt'),
    /トークン制限により途中で切断されました/,
  );
});
