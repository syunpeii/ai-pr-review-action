import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPrInstructions } from '../dist/instructions.js';

const block = (text) => `<!-- AI_REVIEW_INSTRUCTIONS_START\n${text}\nAI_REVIEW_INSTRUCTIONS_END -->`;

test('no block', () => {
  const r = extractPrInstructions('## 概要\nfoo');
  assert.deepEqual(r, { body: '## 概要\nfoo', instructions: '', found: false, malformed: false });
});

test('null body', () => {
  assert.equal(extractPrInstructions(null).found, false);
});

test('extracts instruction and removes it from body', () => {
  const r = extractPrInstructions(`## 概要\nfoo\n\n${block('競合を確認\n整合性も')}\n`);
  assert.equal(r.instructions, '競合を確認\n整合性も');
  assert.equal(r.body, '## 概要\nfoo');
  assert.ok(r.found && !r.malformed);
});

test('CRLF is supported', () => {
  const r = extractPrInstructions(`本文\r\n<!-- AI_REVIEW_INSTRUCTIONS_START\r\nA\r\nB\r\nAI_REVIEW_INSTRUCTIONS_END -->\r\n`);
  assert.equal(r.instructions, 'A\nB');
  assert.equal(r.body, '本文');
});

test('multiple blocks are joined in order; empty block is found but empty', () => {
  const r = extractPrInstructions(`${block('first')}\nmid\n${block('  ')}\n${block('second')}`);
  assert.equal(r.instructions, 'first\n\nsecond');
  assert.equal(r.body, 'mid');
  const empty = extractPrInstructions(block(''));
  assert.ok(empty.found);
  assert.equal(empty.instructions, '');
});

test('instruction at the end of a very long body is still extracted', () => {
  const r = extractPrInstructions('x'.repeat(50_000) + '\n' + block('末尾の指示'));
  assert.equal(r.instructions, '末尾の指示');
  assert.equal(r.body.length, 50_000);
});

test('missing end marker is malformed and not treated as instruction', () => {
  const body = '本文\n<!-- AI_REVIEW_INSTRUCTIONS_START\nこれは指示ではない\nさらに本文';
  const r = extractPrInstructions(body);
  assert.ok(r.malformed);
  assert.equal(r.instructions, '');
  assert.ok(r.body.includes('これは指示ではない'));
});

test('malformed start does not swallow a following valid block', () => {
  const r = extractPrInstructions(`<!-- AI_REVIEW_INSTRUCTIONS_START\nbroken\n${block('valid')}`);
  assert.equal(r.instructions, 'valid');
  assert.ok(r.malformed);
});

test('lowercase markers are not recognized', () => {
  const r = extractPrInstructions('<!-- ai_review_instructions_start\nx\nai_review_instructions_end -->');
  assert.equal(r.found, false);
});
