import path from 'node:path';

function readNumber(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  return {
    port: readNumber(env.PORT, 3000),
    groqApiKey: env.GROQ_API_KEY || '',
    groqModel: env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    confidenceThreshold: readNumber(env.CONFIDENCE_THRESHOLD, 0.75),
  };
}
