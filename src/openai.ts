// path: scripts/review/src/openai.ts
import fetch from 'node-fetch';
import { z } from 'zod';
import type { Config } from './config.js';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ReviewResult {
  summary: string;
  lineComments: LineComment[];
  model: string;
  tokenUsage: TokenUsage;
}

export interface LineComment {
  path: string;
  line: number;
  tag: 'critical' | 'performance' | 'style';
  message: string;
  suggestion?: string;
}

export interface ReviewCandidate extends LineComment {
  id: string;
}

export class VerificationError extends Error {
  constructor(message: string, public readonly tokenUsage?: TokenUsage) {
    super(message);
    this.name = 'VerificationError';
  }
}

const commentTagSchema = z.enum(['critical', 'performance', 'style']);

const revisedCommentSchema = z.object({
  path: z.string().trim().min(1).refine((v) => !/[\r\n]/.test(v), '改行を含められません'),
  line: z.number().int().positive(),
  tag: commentTagSchema,
  message: z.string().trim().min(1),
  suggestion: z.string().trim().min(1).optional(),
}).strict();

const verificationResponseSchema = z.object({
  summary: z.string().trim().min(1),
  decisions: z.array(
    z.object({
      id: z.string().min(1),
      verdict: z.enum(['keep', 'revise', 'drop']),
      reason: z.string().optional(),
      revised: revisedCommentSchema.optional(),
    }).strict(),
  ),
}).strict();

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

/**
 * 検証応答を厳密に検証し、採用・修正された候補だけから最終指摘を組み立てる。
 * 形式不正・ID の重複/未知/判定漏れは例外とし、「問題なし」とは解釈しない。
 */
export function parseVerificationResponse(
  content: string,
  candidates: ReviewCandidate[],
): { summary: string; lineComments: LineComment[] } {
  let json: unknown;
  try {
    json = extractJson(content);
  } catch {
    throw new Error('JSONとして解析できません');
  }

  const parsed = verificationResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
    );
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const decisions = new Map<string, z.infer<typeof verificationResponseSchema>['decisions'][number]>();
  for (const decision of parsed.data.decisions) {
    if (!byId.has(decision.id)) throw new Error(`未知の候補IDです: ${decision.id}`);
    if (seen.has(decision.id)) throw new Error(`候補IDが重複しています: ${decision.id}`);
    seen.add(decision.id);
    if (decision.verdict === 'revise' && !decision.revised) {
      throw new Error(`revise に修正版がありません: ${decision.id}`);
    }
    decisions.set(decision.id, decision);
  }
  const missing = candidates.filter((c) => !seen.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    throw new Error(`判定が欠落している候補があります: ${missing.join(', ')}`);
  }

  const lineComments: LineComment[] = [];
  for (const candidate of candidates) {
    const decision = decisions.get(candidate.id)!;
    if (decision.verdict === 'drop') continue;
    if (decision.verdict === 'keep') {
      const { id: _id, ...comment } = candidate;
      lineComments.push(comment);
    } else {
      lineComments.push(decision.revised!);
    }
  }

  return { summary: parsed.data.summary, lineComments };
}

export class OpenAIService {
  private config: Config;
  private fetchImpl: typeof fetch;

  constructor(config: Config, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async generateReview(prompt: string): Promise<ReviewResult> {
    const model = this.config.openaiModel;
    console.log(`🤖 使用モデル: ${model}`);

    const { content, tokenUsage } = await this.callModel(this.getSystemPrompt(), prompt);
    const { summary, lineComments } = this.parseReviewResponse(content);
    return {
      summary,
      lineComments,
      model,
      tokenUsage,
    };
  }

  /**
   * 下書きレビューを元のコンテキストと照合して検証し、確定版を返す。
   * 検証に失敗した場合は VerificationError を投げる（未検証の候補は返さない）。
   */
  async verifyReview(prompt: string, draft: ReviewResult): Promise<ReviewResult> {
    const model = this.config.openaiModel;
    console.log(`🔎 検証レビューを実行中 (モデル: ${model})`);

    const candidates: ReviewCandidate[] = draft.lineComments.map((comment, index) => ({
      ...comment,
      id: `C${index + 1}`,
    }));
    const verificationInput = this.buildVerificationInput(prompt, draft.summary, candidates);

    let content: string;
    let usage: TokenUsage;
    let truncated: boolean;
    try {
      ({ content, tokenUsage: usage, truncated } = await this.callModel(
        this.getVerificationSystemPrompt(),
        verificationInput,
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new VerificationError(`検証APIの呼び出しに失敗しました: ${message}`);
    }

    if (truncated) {
      throw new VerificationError('検証応答がトークン制限により途中で切断されました', usage);
    }

    try {
      const { summary, lineComments } = parseVerificationResponse(content, candidates);
      return { summary, lineComments, model, tokenUsage: usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new VerificationError(`検証結果が不正です: ${message}`, usage);
    }
  }

  private buildVerificationInput(
    prompt: string,
    draftSummary: string,
    candidates: ReviewCandidate[],
  ): string {
    return `# レビュー対象のコンテキスト（検証の根拠となる一次情報）

${prompt}

# 検証対象: 下書きレビュー（権威ある正解ではありません）

## 下書きの概要
${draftSummary || '（なし）'}

## 指摘候補（JSON）
${JSON.stringify(candidates, null, 2)}`;
  }

  /** 検証入力の概算トークン数 */
  estimateVerificationTokens(prompt: string, draft: ReviewResult): number {
    const candidates: ReviewCandidate[] = draft.lineComments.map((comment, index) => ({
      ...comment,
      id: `C${index + 1}`,
    }));
    const text =
      this.getVerificationSystemPrompt() +
      this.buildVerificationInput(prompt, draft.summary, candidates);
    return Math.ceil(text.length / 3.5);
  }

  private async callModel(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ content: string; tokenUsage: TokenUsage; truncated: boolean }> {
    const model = this.config.openaiModel;

    const response = await this.fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        // PR の差分やレビュー結果を Responses API の Application State に保持しない。
        store: false,
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: systemPrompt }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: userPrompt }],
          },
        ],
        ...(this.config.maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: this.config.maxOutputTokens }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`❌ OpenAI APIエラー: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;

    const content = this.extractResponseText(data);
    const finishReason = data?.status === 'incomplete'
      ? data?.incomplete_details?.reason ?? 'incomplete'
      : data?.status ?? data?.output?.[0]?.status;
    const tokens = data?.usage;

    console.log('🔍 API統計:', {
      コンテンツ長: content?.length || 0,
      終了理由: finishReason,
      入力トークン: tokens?.input_tokens,
      出力トークン: tokens?.output_tokens
    });

    if (!content) {
      if (finishReason === 'incomplete' || finishReason === 'max_output_tokens') {
        throw new Error('❌ レスポンスがトークン制限により途中で切断されました。OPENAI_MAX_OUTPUT_TOKENS の値を増やしてください。');
      }
      throw new Error(`❌ OpenAI APIからレスポンスを取得できませんでした。終了理由: ${finishReason}`);
    }

    if (finishReason === 'incomplete' || finishReason === 'max_output_tokens') {
      console.log('⚠️  警告: レスポンスがトークン制限により途中で切断された可能性があります');
    }

    const tokenUsage: TokenUsage = {
      promptTokens: tokens?.input_tokens || 0,
      completionTokens: tokens?.output_tokens || 0,
      totalTokens: tokens?.total_tokens || ((tokens?.input_tokens || 0) + (tokens?.output_tokens || 0)),
    };

    return {
      content,
      tokenUsage,
      truncated: finishReason === 'incomplete' || finishReason === 'max_output_tokens',
    };
  }

  private extractResponseText(data: any): string | undefined {
    if (typeof data?.output_text === 'string' && data.output_text.trim()) {
      return data.output_text;
    }

    const output = Array.isArray(data?.output) ? data.output : [];
    const texts: string[] = [];

    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const part of content) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          texts.push(part.text);
        }
      }
    }

    const joined = texts.join('\n').trim();
    return joined || undefined;
  }

  private getVerificationSystemPrompt(): string {
    const language = (this.config.commentLanguage || 'ja').trim().toLowerCase();
    const languageInstruction = language === 'en'
      ? 'Write summary, message and suggestion in English.'
      : 'summary、message、suggestion は日本語で記述してください。';

    return `あなたはPRレビューの検証担当です。下書きレビューの指摘候補を、PRのコード（一次情報）と照合して検証します。
下書きの文章は権威ある正解ではありません。コードから自分で確認してください。

## 検証内容
各候補について次を確認します。
- コード上の根拠が存在するか
- 問題が発生する条件と影響が具体的か
- 既存の処理（別の箇所での対処、型・ガード等）で既に対処されていないか
- 説明・修正案が妥当か（パス・行番号・タグも含む）

## 判定
- keep: そのまま妥当
- revise: 問題は存在するが説明・修正案・行番号・タグに問題があるため修正版を返す
- drop: 誤指摘、または根拠不足

新規の指摘を追加してはいけません。候補の採用・修正・却下のみを行ってください。
「確実に問題が存在すると断定できる」ものだけを残し、推測・曖昧な提案は drop してください。
タグの意味: critical=確実に修正が必要な不具合、performance=具体的に確認できる非効率・可読性の問題、style=typo・明確な規約違反。

## 出力形式
次のJSONオブジェクトのみを出力してください（前後の説明文・コードフェンスは禁止）。
{
  "summary": "最終的な指摘と整合するPR全体の評価（1-3文）。却下した問題に言及しない",
  "decisions": [
    { "id": "C1", "verdict": "keep", "reason": "内部用の理由" },
    { "id": "C2", "verdict": "revise", "reason": "内部用の理由",
      "revised": { "path": "src/a.ts", "line": 12, "tag": "critical", "message": "...", "suggestion": "（任意）" } },
    { "id": "C3", "verdict": "drop", "reason": "内部用の理由" }
  ]
}
- すべての候補IDについて、ちょうど1つの判定を含めること（候補が0件なら decisions は空配列）
- reason は投稿されない内部用メモ。revised は verdict が revise のときのみ
- summary は候補が0件でも、下書きの概要を検証して必ず返すこと

## 言語指定
${languageInstruction}`;
  }

  private getSystemPrompt(): string {
    const additionalRulesSection = this.config.additionalRules 
      ? `\n## 追加ルール\n${this.config.additionalRules.trim()}`
      : '';
    const language = (this.config.commentLanguage || 'ja').trim().toLowerCase();
    const languageInstruction = language === 'en'
      ? 'Write all summary and review comments in English.'
      : '要約とレビューコメントはすべて日本語で記述してください。';

    return `あなたは${this.config.reviewerRole}です。PRレビューを実施し、以下の厳密な形式で回答してください。

## 出力形式

以下の厳密な形式に従って出力してください。マーカーは正確に記述すること：

**SUMMARY_START**
PRの全体的な評価を1-3文で記述
**SUMMARY_END**

**COMMENTS_START**
具体的な問題がある場合のみ、以下の厳密な形式で各コメントを記述：

filepath.kt:123
[critical]
具体的な問題の説明（確実に修正が必要な根拠を明示）

filepath.kt:456
[performance]
非効率な処理の説明（現在のコードで確認できる具体的な問題点を明示）

重要: 必ずファイルパスの後に「:行番号」を付けること。行番号が不明な場合は「:1」を使用。

## フォーマット指示
- コメント本文で複数の項目を列挙する場合のみ、Markdownリスト形式を使用
- 単一の内容や通常の文章では「-」は使用しない
- セクション見出し（**見出し**）の後は必ず改行を入れる
- 長いコメントは適切に段落分けする
- 各行コメントは単一の問題に焦点を当て、複数の問題を混在させない
- 総括的なコメントや複数項目の提案は行コメントではなくSUMMARY部分に記述する
（コメントがない場合は何も記述しない）
**COMMENTS_END**

重要: 必ず **SUMMARY_END** と **COMMENTS_END** マーカーで終了すること。**END** や他のマーカーは使用禁止。

## タグの使用指針（厳格に適用）
- critical: 確実に修正が必要（実際のバグ、コンパイルエラー、明確なルール違反が確認済み）
- performance: 非効率な処理、可読性の問題（現在のコードで確認できる具体的な問題のみ）
- style: typo、コーディング規約違反（明確に確認できるもののみ）

## レビュー厳格化ルール（最重要）

**絶対にコメントしてはいけない例：**
- 推測や憶測に基づくコメント（「〜の可能性がある」「〜かもしれない」「〜を確認してください」等）
- バージョン依存の指摘（Kotlinバージョンによって問題があるかもといった指摘）
- 仕様が不明確な指摘（バックエンドの仕様と一致するか確認してください等）
- テストで検証すべきという指摘（テストコード自体に問題がない限り不要）
- 曖昧な提案（「〜を検討してください」「〜が推奨されます」「〜すべきです」等）
- 一般的なベストプラクティスの提案（コードに具体的な問題がない場合）
- 「良い実装です」「適切です」といった賞賛や情報提供

**コメントすべき唯一の基準：**
現在のコードを読んで、**今この瞬間に確実に問題が存在すると断定できる**場合のみコメントする。
- バグ: 実行時エラーやロジックエラーが確実に発生する
- コンパイルエラー: ビルドが失敗する
- 明確なルール違反: プロジェクトのコーディング規約に明確に違反している
- パフォーマンス問題: 現在のコードで明らかに非効率な処理が確認できる（推測ではない）
- typo: スペルミスが確認できる

**判断基準：**
「このコードは動作しますか？」→「はい」ならコメント不要
「このコードに明確な問題がありますか？」→「いいえ」または「わからない」ならコメント不要

## レビュー観点
- ${this.config.reviewFocus}
- ${this.config.techStack}
- テストの品質
${additionalRulesSection}

## 言語指定
${languageInstruction}

## レビューの視点
- PRの変更内容（修正後のコード）を中心に評価してください
- 削除されたコードではなく、新しく追加されたコードや変更後のコードの妥当性を判断してください`;
  }

  private parseReviewResponse(content: string): { summary: string; lineComments: LineComment[] } {
    let summary = '';
    const lineComments: LineComment[] = [];

    const summaryMatch = content.match(/\*\*SUMMARY_START\*\*([\s\S]*?)\*\*SUMMARY_END\*\*/);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    } else {
      console.warn('⚠️  マーカー形式未検出 - 全体を概要として使用');
      summary = content.trim();
    }

    let commentsMatch = content.match(/\*\*COMMENTS_START\*\*([\s\S]*?)(\*\*COMMENTS_END\*\*|\*\*END\*\*)/);
    
    if (!commentsMatch && content.includes('**COMMENTS_START**')) {
      const startIndex = content.indexOf('**COMMENTS_START**') + '**COMMENTS_START**'.length;
      const afterStart = content.substring(startIndex);
      const cleanedComments = afterStart.replace(/\s*(END|end|\*\*END\*\*)\s*$/i, '').trim();
      commentsMatch = [content, cleanedComments, 'no-end-marker'];
    }
    
    if (commentsMatch) {
      const commentsSection = commentsMatch[1].trim();
      if (commentsSection) {
        const commentBlocks = this.splitCommentBlocks(commentsSection);
        for (const block of commentBlocks) {
          const comment = this.parseCommentBlock(block);
          if (comment) {
            lineComments.push(comment);
          }
        }
      }
    } else {
      console.warn('⚠️  COMMENTS_START マーカーが見つかりませんでした');
    }

    console.log('🎯 パース結果:', {
      概要文字数: summary.length,
      行コメント数: lineComments.length
    });

    return {
      summary,
      lineComments,
    };
  }

  private splitCommentBlocks(commentsSection: string): string[] {
    const lines = commentsSection.split('\n');
    const blocks: string[] = [];
    let currentBlock: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      if (trimmed.match(/^[^:]+:\d+$/) || (trimmed.match(/^[^:\[\]]+\.(kt|java|xml|yml|yaml|gradle|json|properties)$/) && !trimmed.includes('['))) {
        const normalizedLine = trimmed.includes(':') ? line : `${line.trim()}:1`;
        
        if (currentBlock.length > 0) {
          blocks.push(currentBlock.join('\n'));
        }
        currentBlock = [normalizedLine];
      } else if (currentBlock.length > 0) {
        if (trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.length > 4) {
          if (currentBlock.length > 0) {
            blocks.push(currentBlock.join('\n'));
            currentBlock = [];
          }
        } else {
          currentBlock.push(line);
        }
      }
    }

    if (currentBlock.length > 0) {
      blocks.push(currentBlock.join('\n'));
    }

    console.log(`📋 コメントブロック数: ${blocks.length}`);
    return blocks;
  }

  private parseCommentBlock(block: string): LineComment | null {
    const lines = block.split('\n');
    
    if (lines.length < 3) return null;

    // 最初の行からファイルパスと行番号を抽出
    const firstLine = lines[0].trim();
    const pathMatch = firstLine.match(/^(.+):(\d+)$/);
    
    if (!pathMatch) return null;
    
    const path = pathMatch[1];
    const line = parseInt(pathMatch[2]);

    // 2行目からタグを抽出
    const secondLine = lines[1].trim();
    const tagMatch = secondLine.match(/^\[(\w+)\]$/);
    
    if (!tagMatch) return null;
    
    const tag = tagMatch[1].toLowerCase() as 'critical' | 'performance' | 'style';

    // 残りの行をメッセージとして結合
    const message = lines.slice(2)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .join(' ')
      .trim();

    if (!message) return null;

    return {
      path,
      line,
      tag,
      message,
    };
  }
}
