// Tunable knowledge for `skills.mjs`. Contributions welcome: add queries, vendors, or off-domain terms.

// cluster -> [weight, queries]. Weights express how much a cluster matters in general; the user's detected stack adds more queries on top.
export const CLUSTERS = {
  webstack:  [1.0, ['nextjs', 'next.js app router', 'react', 'react best practices', 'server components', 'tailwind', 'typescript', 'shadcn', 'web performance', 'core web vitals', 'accessibility', 'i18n', 'forms validation zod', 'seo']],
  backend:   [1.0, ['supabase', 'postgres', 'row level security', 'database migrations', 'drizzle', 'redis', 'queue', 'api design', 'webhooks', 'rate limiting', 'authentication', 'stripe', 'payments billing', 'cloudflare', 'vercel deployment', 'sentry', 'observability logging']],
  testing:   [0.9, ['playwright', 'e2e testing', 'vitest', 'jest', 'pytest', 'testing strategy', 'test driven development', 'regression tests', 'test coverage', 'browser testing']],
  python:    [0.9, ['python', 'python best practices', 'pydantic', 'fastapi', 'asyncio', 'type hints', 'python packaging uv', 'python error handling']],
  llmapps:   [0.8, ['llm evaluation', 'rag', 'embeddings', 'vector database', 'prompt engineering', 'voice agent', 'speech to text', 'text to speech', 'agent framework', 'mcp server', 'structured output']],
  workflow:  [1.0, ['handoff', 'context engineering', 'context management', 'memory', 'planning', 'spec driven', 'task breakdown', 'grill', 'interview requirements', 'prd', 'architecture decision records', 'documentation']],
  quality:   [1.0, ['debugging', 'root cause analysis', 'code review', 'refactoring', 'code simplification', 'verification', 'audit', 'production readiness', 'quality gate', 'technical debt']],
  security:  [0.9, ['security', 'owasp', 'threat modeling', 'secrets management', 'dependency audit', 'prompt injection', 'secure coding']],
  git_ship:  [0.8, ['git workflow', 'git worktree', 'pull request', 'commit messages', 'changelog', 'release management', 'ci cd', 'github actions', 'deployment', 'rollback']],
  agentops:  [0.9, ['claude code', 'codex', 'agents md', 'claude md', 'skill creator', 'subagents', 'parallel agents', 'agent harness', 'hooks', 'guardrails', 'token optimization', 'cost reduction']],
  browser:   [0.6, ['chrome devtools', 'browser automation', 'screenshot', 'lighthouse']],
};

// Dependencies worth a dedicated query when found in the user's manifests (the skill name usually matches the library).
export const DEP_STOP = new Set(['react-dom', 'typescript', 'eslint', 'prettier', 'clsx', 'date-fns', 'tslib', 'dotenv', 'cors', 'axios', 'lodash', 'uuid', 'zod-to-json-schema', 'postcss', 'autoprefixer', 'tailwindcss-animate', 'next-themes', 'class-variance-authority', 'tailwind-merge']);

// Publishers whose own tooling installs their skills: huge install-to-star ratios are expected, not suspicious.
export const VENDOR = /^(vercel|vercel-labs|anthropics|microsoft|github|google|googleworkspace|cloudflare|supabase|stripe|clerk|openai|prisma|neondatabase|firebase|sentry|getsentry|upstash|resend|better-auth|get-convex|shadcn-ui|shadcn|playwright|chromedevtools|currents-dev|mattpocock|addyosmani|obra|wshobson|antfu|nextlevelbuilder|trailofbits)\//i;

// Source/skill names that are clearly outside a web + Python developer's world; override per user in the future.
export const OFF_SOURCE = /(azure|firebase|solana|amazon|heygen|hyperframes|runcomfy|comfy|remotion|lark|feishu|marketingskills|scrape|anti-detect|browser-act|obsidian|autonnel|nexscope|aws|gcp|vue|svelte|angular|flutter|swift|kotlin|rust|golang|unity|godot)/i;
export const OFF_SKILL = /\b(marketing|copywriting|cold.?email|ads?\b|social|tiktok|instagram|youtube|linkedin|resume|career|interview prep|game|unity|unreal|godot|bio|genom|chemistry|protein|clinical|medical|health|swift|kotlin|android|ios\b|flutter|react.native|expo|angular|vue|svelte|laravel|php|rails|ruby|rust|golang|java\b|spring|dotnet|csharp|kubernetes|terraform|aws|azure|gcp|firebase|wordpress|shopify|salesforce|odoo|crypto|blockchain|solidity|nft|logo|brand|podcast|newsletter|ebook|course|flashcard|fitness|recipe|travel|tarot|remotion|lark|feishu|wechat|figma|sketch)\b/i;
// Publishers of a specific PRODUCT: their skills only fit you if you use that product (a Clerk skill about Next.js is not for someone on Supabase auth).
export const PRODUCT_VENDORS = /^(clerk|firebase|get-convex|convex|prisma|neondatabase|sentry|getsentry|upstash|resend|supabase|stripe|cloudflare|better-auth|expo|microsoft|google|sanity-io|langchain-ai|hashicorp|mongodb|shopify|twilio|vapi-ai)\//i;
export const MIRROR = /(-zh|-cn|-ja|-ko|-es|-de|-fr|-pt|-ru|-tw)(\b|-)|mirror|translation/i;
