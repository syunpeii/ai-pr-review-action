// path: scripts/review/src/config.ts
import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
import { resolve } from 'path';
import { z } from 'zod';
export const DEFAULT_MAX_PR_BODY_CHARS = 10_000;
export const MAX_PROJECT_CONTEXT_CHARS = 30_000;
const aiReviewConfigSchema = z.object({
    project_context: z.string().max(MAX_PROJECT_CONTEXT_CHARS).optional(),
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
export function loadConfig() {
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
    const maxOutputTokens = parseOptionalPositiveInteger(process.env.OPENAI_MAX_OUTPUT_TOKENS || process.env.INPUT_MAX_OUTPUT_TOKENS, 'max_output_tokens');
    const maxInputTokens = parseOptionalPositiveInteger(process.env.OPENAI_MAX_INPUT_TOKENS || process.env.INPUT_MAX_INPUT_TOKENS, 'max_input_tokens');
    const githubRepository = process.env.GITHUB_REPOSITORY;
    if (!githubRepository) {
        throw new Error('❌ 環境変数 GITHUB_REPOSITORY が設定されていません');
    }
    const [owner, repo] = githubRepository.split('/');
    // PR番号を複数のソースから取得（安全なフォールバック）
    let pullNumber = 0;
    if (process.env.GITHUB_EVENT_PATH) {
        let eventData;
        try {
            eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
        }
        catch (error) {
            console.warn('⚠️  Failed to parse GITHUB_EVENT_PATH:', error);
        }
        if (eventData) {
            // issue_comment はリポジトリのシークレットを利用して実行されることがあるため、
            // 信頼できるリポジトリ参加者からのコマンドだけを受け付ける。
            if (eventData.issue && eventData.comment) {
                const allowedAssociations = new Set(['MEMBER', 'OWNER', 'COLLABORATOR']);
                const authorAssociation = eventData.comment.author_association;
                if (!allowedAssociations.has(authorAssociation)) {
                    throw new Error('issue_comment からの実行は MEMBER、OWNER、COLLABORATOR に限定されています');
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
    const projectContext = aiReviewConfig.project_context?.trim() || undefined;
    const maxPrBodyChars = parseOptionalPositiveInteger(process.env.AI_REVIEW_MAX_PR_BODY_CHARS || process.env.INPUT_MAX_PR_BODY_CHARS, 'max_pr_body_chars') ?? DEFAULT_MAX_PR_BODY_CHARS;
    const openaiModel = process.env.OPENAI_MODEL ||
        process.env.INPUT_MODEL ||
        aiReviewConfig.default_model ||
        'gpt-6-luna';
    return {
        reviewMode: parseReviewMode(process.env.AI_REVIEW_MODE || process.env.INPUT_REVIEW_MODE),
        openaiApiKey: requiredEnvVars.openaiApiKey,
        openaiModel,
        githubToken: requiredEnvVars.githubToken,
        maxOutputTokens,
        maxInputTokens,
        owner,
        repo,
        pullNumber,
        projectContext,
        maxPrBodyChars,
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
const REMOVED_FIELDS = {
    reviewer_role: 'project_context に記載してください',
    tech_stack: 'project_context に記載してください',
    review_focus: 'project_context に記載してください',
    additional_rules: 'project_context（共通情報）または PR 本文の AI_REVIEW_INSTRUCTIONS ブロック（今回だけの指示）に記載してください',
};
export function assertNoRemovedFields(raw) {
    if (typeof raw !== 'object' || raw === null)
        return;
    const found = Object.keys(raw).filter((key) => key in REMOVED_FIELDS);
    if (found.length === 0)
        return;
    throw new Error('v2 で削除された設定が含まれています: ' +
        found.map((key) => `${key}（${REMOVED_FIELDS[key]}）`).join('、'));
}
function parseReviewMode(value) {
    const mode = value?.trim().toLowerCase();
    if (!mode)
        return 'single';
    if (mode === 'single' || mode === 'verified')
        return mode;
    throw new Error('❌ review_mode には single または verified を指定してください');
}
function parseOptionalPositiveInteger(value, name) {
    if (!value?.trim())
        return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`❌ ${name} には 1 以上の整数を指定してください`);
    }
    return parsed;
}
function loadAIReviewConfig() {
    const configuredPath = process.env.AI_REVIEW_CONFIG_PATH ||
        process.env.INPUT_CONFIG_PATH ||
        '.ai-review.yml';
    const configPath = resolve(process.cwd(), configuredPath);
    if (!existsSync(configPath)) {
        console.log(`📄 ${configuredPath} not found. Using default configuration.`);
        return {};
    }
    try {
        const configContent = readFileSync(configPath, 'utf8');
        const rawConfig = load(configContent);
        assertNoRemovedFields(rawConfig);
        const parsedConfig = aiReviewConfigSchema.safeParse(rawConfig);
        if (!parsedConfig.success) {
            const details = parsedConfig.error.issues
                .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
                .join('; ');
            throw new Error(details);
        }
        const config = parsedConfig.data;
        console.log(`📄 Loaded configuration from ${configuredPath}`);
        return config;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`❌ ${configuredPath} の設定が不正です: ${message}`);
    }
}
