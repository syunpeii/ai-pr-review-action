// path: scripts/review/src/config.ts
import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
import { resolve } from 'path';
import { z } from 'zod';

export interface Config {
  openaiApiKey: string;
  openaiModel: string;
  githubToken: string;
  maxOutputTokens?: number;
  maxInputTokens?: number;
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

const aiReviewConfigSchema = z.object({
  reviewer_role: z.string().max(500).optional(),
  tech_stack: z.string().max(2_000).optional(),
  review_focus: z.string().max(2_000).optional(),
  additional_rules: z.string().max(10_000).optional(),
  default_model: z.string().min(1).max(200).optional(),
  file_priorities: z
    .record(z.string().min(1).max(50), z.number().int().min(1).max(10))
    .refine((priorities) => Object.keys(priorities).length <= 100, {
      message: '最大100件まで指定できます',
    })
    .optional(),
  exclude_patterns: z.array(z.string().min(1).max(500)).max(100).optional(),
  comment_language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, '言語タグの形式で指定してください')
    .max(35)
    .optional(),
  include_pr_title: z.boolean().optional(),
  include_pr_body: z.boolean().optional(),
  include_pr_labels: z.boolean().optional(),
}).strict();

type AIReviewConfig = z.infer<typeof aiReviewConfigSchema>;

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

  const maxOutputTokens = parseOptionalPositiveInteger(
    process.env.OPENAI_MAX_OUTPUT_TOKENS || process.env.INPUT_MAX_OUTPUT_TOKENS,
    'max_output_tokens',
  );
  const maxInputTokens = parseOptionalPositiveInteger(
    process.env.OPENAI_MAX_INPUT_TOKENS || process.env.INPUT_MAX_INPUT_TOKENS,
    'max_input_tokens',
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
    maxInputTokens,
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

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (!value?.trim()) return undefined;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`❌ ${name} には 1 以上の整数を指定してください`);
  }

  return parsed;
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
    const parsedConfig = aiReviewConfigSchema.safeParse(load(configContent));
    if (!parsedConfig.success) {
      const details = parsedConfig.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ');
      throw new Error(details);
    }

    const config = parsedConfig.data;
    console.log(`📄 Loaded configuration from ${configuredPath}`);
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`❌ ${configuredPath} の設定が不正です: ${message}`);
  }
}
