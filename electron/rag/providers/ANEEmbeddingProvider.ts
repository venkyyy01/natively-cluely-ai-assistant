import { IEmbeddingProvider } from './IEmbeddingProvider';
import { isAppleSilicon, isOptimizationActive } from '../../config/optimizations';
import path from 'path';

let ort: any = null;
let loadError: Error | null = null;

async function loadOnnxRuntime() {
  if (ort !== null) return ort;

  try {
    ort = await import('onnxruntime-node');
    return ort;
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
    console.warn('[ANEEmbeddingProvider] ONNX Runtime not available:', loadError.message);
    return null;
  }
}

export class ANEEmbeddingProvider implements IEmbeddingProvider {
  readonly name = 'ane-embedding';
  readonly dimensions = 384;
  
  private session: any = null;
  private tokenizer: any = null;
  private useANE: boolean = false;
  private initialized: boolean = false;
  private warmedUp: boolean = false;

  async initialize(): Promise<void> {
    if (!isOptimizationActive('useANEEmbeddings')) {
      console.log('[ANEEmbeddingProvider] Disabled via flag (toggle OFF), skipping initialization');
      return;
    }

    const runtime = await loadOnnxRuntime();
    if (!runtime) {
      console.warn('[ANEEmbeddingProvider] ONNX Runtime failed to load, embeddings will fall back to existing provider');
      return;
    }

    try {
      const modelPath = this.getModelPath();

      const executionProviders = isAppleSilicon()
        ? ['coreml', 'cpu']
        : ['cpu'];

      this.session = await runtime.InferenceSession.create(modelPath, {
        executionProviders,
        graphOptimizationLevel: 'all',
      });

      this.useANE = executionProviders[0] === 'coreml';
      this.tokenizer = await this.loadTokenizer();
      this.initialized = true;

      console.log(`[ANEEmbeddingProvider] Initialized with: ${this.useANE ? 'CoreML (ANE)' : 'CPU'}`);

      await this.warmup();

    } catch (error) {
      console.warn('[ANEEmbeddingProvider] Failed to initialize, falling back to existing provider:', error);
      this.initialized = false;
    }
  }

  async warmup(): Promise<void> {
    if (!this.initialized || this.warmedUp) return;

    try {
      console.log('[ANEEmbeddingProvider] Warming up CoreML model...');
      const start = Date.now();
      await this.embed('warmup dummy text for neural engine graph compilation');
      this.warmedUp = true;
      console.log(`[ANEEmbeddingProvider] Warmup complete in ${Date.now() - start}ms`);
    } catch (error) {
      console.warn('[ANEEmbeddingProvider] Warmup failed (non-fatal):', error);
    }
  }

  private getModelPath(): string {
    const resourcesPath = process.env.NODE_ENV === 'production'
      ? process.resourcesPath
      : path.join(__dirname, '../../resources');

    return path.join(resourcesPath, 'models', 'minilm-l6-v2.onnx');
  }

  private async loadTokenizer(): Promise<any> {
    try {
      const { AutoTokenizer } = await import('@xenova/transformers');
      return await AutoTokenizer.from_pretrained('Xenova/all-MiniLM-L6-v2');
    } catch (error) {
      console.warn('[ANEEmbeddingProvider] @xenova/transformers not available, using fallback tokenizer');
      const vocabPath = path.join(this.getModelPath(), '..', 'tokenizer.json');
      const fs = await import('fs/promises');
      const vocabData = JSON.parse(await fs.readFile(vocabPath, 'utf-8'));
      return this.createTokenizerFromVocab(vocabData);
    }
  }

  private createTokenizerFromVocab(vocabData: any): any {
    const vocab: Record<string, number> = vocabData.model?.vocab || {};
    const unkId = vocab['[UNK]'] || 0;
    const clsId = vocab['[CLS]'] || 101;
    const sepId = vocab['[SEP]'] || 102;

    return {
      encode: (text: string) => {
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        const ids = [clsId, ...words.map(w => vocab[w] || unkId), sepId];
        return {
          ids: ids.slice(0, 256),
          attentionMask: ids.slice(0, 256).map(() => 1),
        };
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.initialized;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.initialized || !this.session) {
      throw new Error('ANEEmbeddingProvider not initialized');
    }

    const tokens = this.tokenizer.encode(text);

    const runtime = await loadOnnxRuntime();
    
    const inputIds = new runtime.Tensor(
      'int64',
      BigInt64Array.from(tokens.ids.map(BigInt)),
      [1, tokens.ids.length]
    );

    const attentionMask = new runtime.Tensor(
      'int64',
      BigInt64Array.from(tokens.attentionMask.map(BigInt)),
      [1, tokens.attentionMask.length]
    );

    const results = await this.session.run({
      input_ids: inputIds,
      attention_mask: attentionMask,
    });

    const embeddings = results['last_hidden_state'].data as Float32Array;
    return this.meanPool(embeddings, tokens.attentionMask);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  private meanPool(embeddings: Float32Array, attentionMask: number[]): number[] {
    const dim = embeddings.length / attentionMask.length;
    const pooled = new Array(dim).fill(0);

    let sum = 0;
    for (let i = 0; i < attentionMask.length; i++) {
      if (attentionMask[i] === 1) {
        sum++;
        for (let j = 0; j < dim; j++) {
          pooled[j] += embeddings[i * dim + j];
        }
      }
    }

    const norm = Math.sqrt(pooled.reduce((a, b) => a + b * b, 0));
    return norm > 0 ? pooled.map(v => v / norm) : pooled;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  supportsANE(): boolean {
    return this.useANE;
  }
}
