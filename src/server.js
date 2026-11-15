import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createGroqExtractor } from './extractor.js';
import { buildWorkbook } from './excel.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = createStore(config.dataDir);
const extractor = createGroqExtractor({ apiKey: config.groqApiKey, model: config.groqModel });
const app = createApp({ store, extractor, config, exportWorkbook: buildWorkbook });

if (!config.groqApiKey) {
  console.warn('Aviso: GROQ_API_KEY no está configurada; la extracción fallará hasta que la añadas a .env');
}

app.listen(config.port, () => {
  console.log(`docs-a-datos escuchando en http://localhost:${config.port} (modelo: ${config.groqModel})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.close();
    process.exit(0);
  });
}
