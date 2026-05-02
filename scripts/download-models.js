const { pipeline, env } = require('@xenova/transformers');
const path = require('path');
const fs = require('fs');

async function downloadModels() {
    const modelsDir = path.join(__dirname, '../resources/models');
    
    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }

    env.cacheDir = modelsDir;
    env.localModelPath = modelsDir;
    env.allowRemoteModels = true;
    
    try {
        console.log('[download-models] Downloading Xenova/all-MiniLM-L6-v2...');
        await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('[download-models] all-MiniLM-L6-v2 downloaded.');

        console.log('[download-models] Downloading Xenova/nli-deberta-v3-small...');
        await pipeline('zero-shot-classification', 'Xenova/nli-deberta-v3-small');
        console.log('[download-models] nli-deberta-v3-small downloaded.');

        console.log('[download-models] All models downloaded successfully!');
    } catch (e) {
        console.error('[download-models] Error downloading model:', e);
        console.error('[download-models] Tip: Run with SKIP_MODEL_DOWNLOAD=1 to skip this step');
        process.exit(1);
    }
}

if (process.env.SKIP_MODEL_DOWNLOAD === '1') {
    console.log('[download-models] Skipping model download (SKIP_MODEL_DOWNLOAD=1)');
    process.exit(0);
}

downloadModels();
