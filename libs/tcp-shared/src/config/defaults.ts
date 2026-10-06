/**
 * Single source of truth for code-level config defaults — the fallback used
 * when a value isn't set anywhere in the resolution chain (role/company
 * `runConfig` → env var → here). Centralised so every default is defined
 * once and easy to find from either direction (the field that uses it, or
 * this file).
 */

// ── Database ─────────────────────────────────────────────────────────────────

/** Default Postgres user. Overridden by `DB_USER` env var. */
export const DEFAULT_DB_USER = 'tcp';

/** Default Postgres password. Overridden by `DB_PASSWORD` env var. */
export const DEFAULT_DB_PASSWORD = 'dev-password';

/** Default Postgres database name. Overridden by `DB_NAME` env var. */
export const DEFAULT_DB_NAME = 'tcp';

// ── MinIO ────────────────────────────────────────────────────────────────────

/** Default MinIO access key. Overridden by `MINIO_ACCESS_KEY` env var. */
export const DEFAULT_MINIO_ACCESS_KEY = 'tcp-access-key';

/** Default MinIO secret key. Overridden by `MINIO_SECRET_KEY` env var. */
export const DEFAULT_MINIO_SECRET_KEY = 'tcp-secret-key';

/** Default MinIO bucket prefix. Overridden by `MINIO_BUCKET_PREFIX` env var. */
export const DEFAULT_MINIO_BUCKET_PREFIX = 'tcp';

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Default internal API key for service-to-service auth. Overridden by `INTERNAL_API_KEY` env var. */
export const DEFAULT_INTERNAL_API_KEY = 'change-me-in-production';

// ── Masking ──────────────────────────────────────────────────────────────────

/** Whether to mask API keys in logs/output. Overridden by `TCP_MASK_API_KEYS` env var. */
export const DEFAULT_TCP_MASK_API_KEYS = true;

// ── Polling ──────────────────────────────────────────────────────────────────

/** Knowledge RAG reindex reconciliation poller interval in ms. Overridden by `KNOWLEDGE_POLL_INTERVAL_MS` env var. */
export const DEFAULT_KNOWLEDGE_POLL_INTERVAL_MS = 60_000;

// ── Exposed Ports ────────────────────────────────────────────────────────────

/*
 * Host ports. Each has its own default, matching docker-compose.yml's
 * `${EXPOSE_PORT_*:-<default>}`; none is derived from another. An instance
 * that must run beside another changes them in its env file.
 */

/** Default API port on the host. Overridden by `EXPOSE_PORT_API`. */
export const DEFAULT_EXPOSE_PORT_API = 3000;

/** Default Postgres port on the host. Overridden by `EXPOSE_PORT_DB`. */
export const DEFAULT_EXPOSE_PORT_DB = 5432;

/** Default MinIO API port on the host. Overridden by `EXPOSE_PORT_MINIO`. */
export const DEFAULT_EXPOSE_PORT_MINIO = 9000;

/** Default MinIO console port on the host. Overridden by `EXPOSE_PORT_MINIO_CONSOLE`. */
export const DEFAULT_EXPOSE_PORT_MINIO_CONSOLE = 9001;

/** Default web client (HTTPS) port on the host. Overridden by `EXPOSE_PORT_WEB`. */
export const DEFAULT_EXPOSE_PORT_WEB = 5173;

/**
 * Default tcp-agent port on the host, published only with `--dev-ports`
 * (start-dev.sh always passes it). Overridden by `EXPOSE_PORT_AGENT`.
 */
export const DEFAULT_EXPOSE_PORT_AGENT = 3003;

/**
 * The bundled Zitadel's host port. Fixed: Zitadel's external port and
 * start-deployment.sh's bootstrap both assume it, so `EXPOSE_PORT_ZITADEL`
 * can't move it (start-deployment.sh refuses any other value).
 */
export const DEFAULT_EXPOSE_PORT_ZITADEL = 8080;

// ── Embedding ────────────────────────────────────────────────────────────────

/**
 * Default embedding dimension when `EMBEDDING_DIMENSION` env var is not set.
 * Must match the default in the Joi config schemas.
 */
export const DEFAULT_EMBEDDING_DIMENSION = 768;

// ── RAG retrieval ────────────────────────────────────────────────────────────

/**
 * Default minimum cosine similarity a knowledge chunk must score to be
 * retrieved. Overridden by `RAG_THRESHOLD` (env), then by
 * {@link AgentRunConfig.ragThreshold} via {@link resolveRunConfig}.
 * Used in {@link KnowledgeRetrievalService.retrieve}.
 *
 * Cosine scores are **not** comparable across embedding models — each has its
 * own score distribution, so this is a per-model calibration, not a universal
 * "relevance" figure. Measured against `nomic-embed-text-v2-moe` over a real
 * corpus, on-topic queries scored 0.39–0.64 while off-topic ones stayed below
 * 0.29; 0.35 sits in that gap. An earlier 0.7 default was above anything that
 * model ever returns, so retrieval silently matched nothing at all — prefer a
 * default that under-filters (a stray chunk the LLM can ignore) over one that
 * disables RAG without a word. Point `RAG_THRESHOLD` elsewhere when swapping
 * to a model whose scores sit on a different scale.
 */
export const DEFAULT_RAG_THRESHOLD = 0.35;

// ── Agent ────────────────────────────────────────────────────────────────────

/**
 * Default maximum LLM invocations per agent run.
 * Overridden by `AGENT_ITERATIONS` (tcp-agent env), then by
 * {@link AgentRunConfig.maxIterations} via {@link resolveRunConfig}.
 * Used in {@link AgentLoopService.run}.
 */
export const DEFAULT_AGENT_ITERATIONS = 40;

/**
 * Default number of agent jobs the tcp-agent worker processes concurrently.
 * Overridden by `AGENT_WORKER_CONCURRENCY` (tcp-agent env). Used in
 * {@link AgentWorkerService}. Set to 1 so agents sharing a single
 * capacity-limited model endpoint (e.g. one local LLM) don't starve each
 * other of model time.
 */
export const DEFAULT_AGENT_WORKER_CONCURRENCY = 1;

/**
 * Default pool total for every agent run against a local model endpoint.
 * Overridden by `MODEL_CONCURRENCY`'s `local` key (tcp-agent env). Used in
 * {@link limitsFor}. Set to 1: a home install typically has one GPU, so
 * parallel runs against it would only queue inside the model server anyway.
 */
export const DEFAULT_LOCAL_MODEL_CONCURRENCY = 1;

/**
 * Default pool total for every agent run against a remote model endpoint.
 * Overridden by `MODEL_CONCURRENCY`'s `remote` key (tcp-agent env). Used in
 * {@link limitsFor}. Remote providers can usually take more parallel work
 * than a local GPU, but an unbounded pool also means an unbounded spend rate.
 */
export const DEFAULT_REMOTE_MODEL_CONCURRENCY = 4;

/**
 * Default wall-clock timeout in milliseconds for an entire agent run.
 * Overridden by `AGENT_LOOP_TIMEOUT_MS` (tcp-agent env), then by
 * {@link AgentRunConfig.timeoutMs} via {@link resolveRunConfig}.
 * Used in {@link AgentLoopService.run}.
 *
 * Kept >= {@link DEFAULT_LLM_TIMEOUT_MS}: a run-level timeout shorter than a
 * single LLM call's own timeout would abort the run before that call could
 * ever legitimately finish, making the per-call timeout pointless.
 */
export const DEFAULT_AGENT_LOOP_TIMEOUT_MS = 30 * 60 * 1000; // 30m

/**
 * Default number of reminder retries when an agent run ends without all of its
 * required tool calls (see {@link TcpAgent.requiredToolCalls}) having fired.
 * Overridden by `AGENT_REQUIRED_TOOL_RETRIES` (tcp-agent env).
 * Used in {@link AgentLoopService}.
 */
export const DEFAULT_REQUIRED_TOOL_RETRIES = 2;

/**
 * Default per-request timeout in milliseconds for a single LLM API call.
 * Overridden by `LlmConfig.timeoutMs` (set via `LLM_TIMEOUT_MS` env when
 * built by {@link resolveEnvLlmConfig}, or stored directly on a role/company
 * `llmConfig`).
 * Used in {@link buildChatModel}.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 30 * 60 * 1000; // 30m

/**
 * Default context window size in tokens, used when {@link LlmConfig.contextWindow}
 * is not set.
 * Used in {@link ContextBudgetService.DEFAULT_WINDOW} and {@link ChatService.sendMessage}.
 */
export const DEFAULT_LLM_CONTEXT_WINDOW = 8192;

/**
 * Default maximum QA rejections a task assignment may accrue before it is
 * failed (and its task with it).
 * Overridden by `TASK_MAX_QA_ATTEMPTS` (tcp-server env), then by
 * {@link AgentRunConfig.maxQaAttempts} via {@link resolveRunConfig}.
 * Used in {@link TaskOrchestrationService}.
 */
export const DEFAULT_TASK_MAX_QA_ATTEMPTS = 3;
