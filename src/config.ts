// path: scripts/review/src/config.ts
import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
import { resolve } from 'path';

export interface Config {
  openaiApiKey: string;
  openaiModel: string;
  githubToken: string;
  maxOutputTokens: number;
  owner: string;
  repo: string;
  pullNumber: number;
  reviewerRole: string;
  techStack: string;
  reviewFocus: string;
  additionalRules?: string;
  filePriorities: Record<string, number>;
  excludePatterns: string[];
  commentLanguage: string;
  includePrTitle: boolean;
  includePrBody: boolean;
  includePrLabels: boolean;
}

interface AIReviewConfig {
  reviewer_role?: string;
  tech_stack?: string;
  review_focus?: string;
  additional_rules?: string;
  default_model?: string;
  file_priorities?: Record<string, number>;
  exclude_patterns?: string[];
  comment_language?: string;
  include_pr_title?: boolean;
  include_pr_body?: boolean;
  include_pr_labels?: boolean;
}

export function loadConfig(): Config {
  const openaiApiKey = process.env.OPENAI_API_KEY || process.env.INPUT_OPENAI_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;
  const requiredEnvVars = {
    openaiApiKey,
    githubToken,
  };

  for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
      throw new Error(`❌ 環境変数 ${key.toUpperCase()} が設定されていません`);
    }
  }

  const maxOutputTokens = parseInt(
    process.env.OPENAI_MAX_OUTPUT_TOKENS ||
      process.env.INPUT_MAX_OUTPUT_TOKENS ||
      '1500',
    10,
  );
  
  const githubRepository = process.env.GITHUB_REPOSITORY;
  if (!githubRepository) {
    throw new Error('❌ 環境変数 GITHUB_REPOSITORY が設定されていません');
  }

  const [owner, repo] = githubRepository.split('/');
  
  // PR番号を複数のソースから取得（安全なフォールバック）
  let pullNumber = 0;
  
  if (process.env.GITHUB_EVENT_PATH) {
    let eventData: any;
    try {
      eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    } catch (error) {
      console.warn('⚠️  Failed to parse GITHUB_EVENT_PATH:', error);
    }

    if (eventData) {
      // issue_comment はリポジトリのシークレットを利用して実行されることがあるため、
      // 信頼できるリポジトリ参加者からのコマンドだけを受け付ける。
      if (eventData.issue && eventData.comment) {
        const allowedAssociations = new Set(['MEMBER', 'OWNER', 'COLLABORATOR']);
        const authorAssociation = eventData.comment.author_association;
        if (!allowedAssociations.has(authorAssociation)) {
          throw new Error(
            'issue_comment からの実行は MEMBER、OWNER、COLLABORATOR に限定されています',
          );
        }
      }

      // 1. pull_request.numberを最優先（pull_requestイベント）
      if (eventData.pull_request?.number) {
        pullNumber = parseInt(eventData.pull_request.number.toString(), 10);
      }
      // 2. issue.number（issue_commentイベント: PRコメントの場合はissue番号=PR番号）
      else if (eventData.issue?.number) {
        pullNumber = parseInt(eventData.issue.number.toString(), 10);
      }
      // 3. top-level numberをフォールバック
      else if (eventData.number) {
        pullNumber = parseInt(eventData.number.toString(), 10);
      }
    }
  }
  
  // 3. 環境変数PR_NUMBERを最終フォールバック
  if (!pullNumber && process.env.PR_NUMBER) {
    pullNumber = parseInt(process.env.PR_NUMBER, 10);
  }

  // 4. Action input (pr_number) をフォールバック
  if (!pullNumber && process.env.INPUT_PR_NUMBER) {
    pullNumber = parseInt(process.env.INPUT_PR_NUMBER, 10);
  }

  if (!pullNumber) {
    throw new Error('❌ PR番号を特定できません。イベントデータ (pull_request.number, event.number) または環境変数 PR_NUMBER を確認してください');
  }

  // .ai-review.yml設定ファイルを読み込み
  const aiReviewConfig = loadAIReviewConfig();
  const customInstructions =
    process.env.AI_REVIEW_CUSTOM_INSTRUCTIONS ||
    process.env.INPUT_CUSTOM_INSTRUCTIONS;
  const additionalRules = [aiReviewConfig.additional_rules?.trim(), customInstructions?.trim()]
    .filter((value): value is string => Boolean(value))
    .join('\n\n');

  const openaiModel =
    process.env.OPENAI_MODEL ||
    process.env.INPUT_MODEL ||
    aiReviewConfig.default_model ||
    'gpt-5-mini';

  return {
    openaiApiKey: requiredEnvVars.openaiApiKey!,
    openaiModel,
    githubToken: requiredEnvVars.githubToken!,
    maxOutputTokens,
    owner,
    repo,
    pullNumber,
    reviewerRole: aiReviewConfig.reviewer_role || '',
    techStack: aiReviewConfig.tech_stack || '',
    reviewFocus: aiReviewConfig.review_focus || '',
    additionalRules: additionalRules || undefined,
    filePriorities: aiReviewConfig.file_priorities || {
      kt: 10, gradle: 9, xml: 8, json: 7, yml: 6, md: 5
    },
    excludePatterns: aiReviewConfig.exclude_patterns || [],
    commentLanguage: aiReviewConfig.comment_language || 'ja',
    includePrTitle: aiReviewConfig.include_pr_title !== false,
    includePrBody: aiReviewConfig.include_pr_body !== false,
    includePrLabels: aiReviewConfig.include_pr_labels !== false,
  };
}

function loadAIReviewConfig(): AIReviewConfig {
  const configuredPath =
    process.env.AI_REVIEW_CONFIG_PATH ||
    process.env.INPUT_CONFIG_PATH ||
    '.ai-review.yml';
  const configPath = resolve(process.cwd(), configuredPath);
  
  if (!existsSync(configPath)) {
    console.log(`📄 ${configuredPath} not found. Using default configuration.`);
    return {};
  }

  try {
    const configContent = readFileSync(configPath, 'utf8');
    const config = load(configContent) as AIReviewConfig;
    console.log(`📄 Loaded configuration from ${configuredPath}`);
    return config || {};
  } catch (error) {
    console.warn(`⚠️  Failed to load ${configuredPath}:`, error);
    console.log('📄 Using default configuration.');
    return {};
  }
}
