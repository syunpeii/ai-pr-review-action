export const INSTRUCTIONS_START = 'AI_REVIEW_INSTRUCTIONS_START';
export const INSTRUCTIONS_END = 'AI_REVIEW_INSTRUCTIONS_END';
// 内容に別の開始マーカーを含めない（終了マーカー欠落の開始が後続ブロックを飲み込まないため）
const BLOCK_PATTERN = new RegExp(`<!--[ \\t]*${INSTRUCTIONS_START}((?:(?!${INSTRUCTIONS_START})[\\s\\S])*?)${INSTRUCTIONS_END}[ \\t]*-->`, 'g');
// 本文の省略や include_pr_body の処理より前に、元の本文全体に対して呼ぶこと
export function extractPrInstructions(rawBody) {
    const normalized = (rawBody ?? '').replace(/\r\n?/g, '\n');
    const blocks = [];
    let found = false;
    const body = normalized.replace(BLOCK_PATTERN, (_match, content) => {
        found = true;
        const trimmed = content.trim();
        if (trimmed)
            blocks.push(trimmed);
        return '';
    });
    // 完結ブロックを除いた後にマーカーが残っていれば不正。内容は通常本文としてのみ扱う。
    const malformed = body.includes(INSTRUCTIONS_START) || body.includes(INSTRUCTIONS_END);
    return {
        body: body.replace(/\n{3,}/g, '\n\n').trim(),
        instructions: blocks.join('\n\n'),
        found,
        malformed,
    };
}
