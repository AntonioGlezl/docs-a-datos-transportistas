import path from 'node:path';

function readNumber(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  return {
    port: readNumber(env.PORT, 3000),
    groqApiKey: env.GROQ_API_KEY || '',
    groqModel: env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    // Images per Groq request (pages per document); qwen/qwen3.8-27b accepts 3
    maxPages: Math.max(1, Math.floor(readNumber(env.GROQ_MAX_IMAGES, 3))),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    confidenceThreshold: readNumber(env.CONFIDENCE_THRESHOLD, 0.75),
  };
}
