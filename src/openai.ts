// path: scripts/review/src/openai.ts
import fetch from 'node-fetch';
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

export class OpenAIService {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async generateReview(prompt: string): Promise<ReviewResult> {
    const model = this.config.openaiModel;
    console.log(`🤖 使用モデル: ${model}`);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: this.getSystemPrompt(),
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_completion_tokens: this.config.maxOutputTokens,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`❌ OpenAI APIエラー: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    
    const content = data.choices?.[0]?.message?.content;
    const finishReason = data.choices?.[0]?.finish_reason;
    const tokens = data.usage;
    
    console.log('🔍 API統計:', {
      コンテンツ長: content?.length || 0,
      終了理由: finishReason,
      入力トークン: tokens?.prompt_tokens,
      出力トークン: tokens?.completion_tokens
    });
    
    // コンテンツの最初と最後を表示（ログ制限回避）
    if (content) {
      console.log('🔍 コンテンツ先頭200文字:', content.substring(0, 200));
      console.log('🔍 コンテンツ末尾200文字:', content.substring(content.length - 200));
    }
    
    if (!content) {
      if (finishReason === 'length') {
        throw new Error('❌ レスポンスがトークン制限により途中で切断されました。OPENAI_MAX_OUTPUT_TOKENS の値を増やしてください。');
      }
      throw new Error(`❌ OpenAI APIからレスポンスを取得できませんでした。終了理由: ${finishReason}`);
    }

    if (finishReason === 'length') {
      console.log('⚠️  警告: レスポンスがトークン制限により途中で切断された可能性があります');
    }

    const tokenUsage: TokenUsage = {
      promptTokens: tokens?.prompt_tokens || 0,
      completionTokens: tokens?.completion_tokens || 0,
      totalTokens: tokens?.total_tokens || 0,
    };

    const { summary, lineComments } = this.parseReviewResponse(content);
    return {
      summary,
      lineComments,
      model,
      tokenUsage,
    };
  }

  private getSystemPrompt(): string {
    const additionalRulesSection = this.config.additionalRules 
      ? `\n## 追加ルール\n${this.config.additionalRules.trim()}`
      : '';

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

## レビューの視点
- PRの変更内容（修正後のコード）を中心に評価してください
- 削除されたコードではなく、新しく追加されたコードや変更後のコードの妥当性を判断してください`;
  }

  private parseReviewResponse(content: string): { summary: string; lineComments: LineComment[] } {
    console.log('🔍 パース開始 - コンテンツ長:', content.length);
    
    let summary = '';
    const lineComments: LineComment[] = [];

    // 新しい形式での抽出を試行
    const summaryMatch = content.match(/\*\*SUMMARY_START\*\*([\s\S]*?)\*\*SUMMARY_END\*\*/);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
      console.log('✅ 概要抽出成功 - 長さ:', summary.length);
    } else {
      // フォールバック: 全体を概要として扱う
      console.log('⚠️  マーカー形式未検出 - 全体を概要として使用');
      summary = content.trim();
    }

    // Comments部分を抽出（より柔軟なマーカー対応）
    let commentsMatch = content.match(/\*\*COMMENTS_START\*\*([\s\S]*?)(\*\*COMMENTS_END\*\*|\*\*END\*\*)/);
    
    // 終了マーカーが見つからない場合、COMMENTS_START以降をすべて取得
    if (!commentsMatch && content.includes('**COMMENTS_START**')) {
      const startIndex = content.indexOf('**COMMENTS_START**') + '**COMMENTS_START**'.length;
      const afterStart = content.substring(startIndex);
      // 末尾のENDやその他のパターンを削除
      const cleanedComments = afterStart.replace(/\s*(END|end|\*\*END\*\*)\s*$/i, '').trim();
      commentsMatch = [content, cleanedComments, 'no-end-marker'];
    }
    
    if (commentsMatch) {
      const commentsSection = commentsMatch[1].trim();
      console.log('✅ 行コメント部分抽出成功 - 長さ:', commentsSection.length);
      console.log('🔍 使用された終了マーカー:', commentsMatch[2]);
      
      if (commentsSection) {
        console.log('🔍 コメント部分の内容:', commentsSection.substring(0, 300));
        const commentBlocks = this.splitCommentBlocks(commentsSection);
        console.log('📋 解析したコメントブロック数:', commentBlocks.length);
        
        if (commentBlocks.length > 0) {
          console.log('📝 最初のブロック例:', commentBlocks[0]);
        }
        
        for (const block of commentBlocks) {
          console.log('🔍 処理中のブロック:', block.substring(0, 100));
          const comment = this.parseCommentBlock(block);
          if (comment) {
            lineComments.push(comment);
            console.log('✅ コメント追加成功:', comment.path + ':' + comment.line);
          } else {
            console.log('❌ コメント解析失敗');
          }
        }
      }
    } else {
      console.log('⚠️  COMMENTS_START マーカーが見つかりませんでした');
      console.log('🔍 コンテンツでCOMMENTS_STARTを検索:', content.includes('**COMMENTS_START**'));
      console.log('🔍 コンテンツでCOMMENTS_ENDを検索:', content.includes('**COMMENTS_END**'));
      console.log('🔍 コンテンツでENDを検索:', content.includes('**END**'));
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

    console.log('🔍 分割処理開始 - 総行数:', lines.length);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      console.log(`行${i}: "${trimmed}"`);
      
      // ファイルパス:行番号 の形式をチェック（行番号なしもサポート）
      if (trimmed.match(/^[^:]+:\d+$/) || (trimmed.match(/^[^:\[\]]+\.(kt|java|xml|yml|yaml|gradle|json|properties)$/) && !trimmed.includes('['))) {
        console.log('✅ ファイルパス パターン検出:', trimmed);
        // 行番号がない場合は:1を追加
        const normalizedLine = trimmed.includes(':') ? line : `${line.trim()}:1`;
        console.log('📝 正規化後:', normalizedLine);
        
        // 前のブロックを保存
        if (currentBlock.length > 0) {
          blocks.push(currentBlock.join('\n'));
          console.log('📦 ブロック保存 - 行数:', currentBlock.length);
        }
        // 新しいブロックを開始
        currentBlock = [normalizedLine];
      } else if (currentBlock.length > 0) {
        // **補足と提案**等の見出しを検出して、そこで現在のブロックを終了
        if (trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.length > 4) {
          console.log('📝 見出し検出によりブロック終了:', trimmed);
          // 現在のブロックを保存してリセット
          if (currentBlock.length > 0) {
            blocks.push(currentBlock.join('\n'));
            console.log('📦 見出しによるブロック保存 - 行数:', currentBlock.length);
            currentBlock = [];
          }
        } else {
          // 現在のブロックに追加
          currentBlock.push(line);
        }
      } else if (trimmed) {
        console.log('⚠️  ブロック外のコンテンツ:', trimmed);
      }
    }

    // 最後のブロックを保存
    if (currentBlock.length > 0) {
      blocks.push(currentBlock.join('\n'));
      console.log('📦 最後のブロック保存 - 行数:', currentBlock.length);
    }

    console.log('🎯 分割完了 - ブロック総数:', blocks.length);
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
