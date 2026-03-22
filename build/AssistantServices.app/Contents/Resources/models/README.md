# ANE Embedding Models

This directory contains the MiniLM-L6-v2 model files for ANE (Apple Neural Engine) accelerated embeddings.

## Required Files

- `vocab.txt` - BERT vocabulary file for tokenization
- `minilm-l6-v2.mlmodelc/` - Compiled CoreML model (or `.mlpackage`)

## Downloading Models

Run the download script to fetch and convert the model:

```bash
./scripts/download-models.sh
```

This will:
1. Download MiniLM-L6-v2 from Hugging Face
2. Export to ONNX format
3. Convert to CoreML format for Neural Engine acceleration
4. Save vocabulary and model files here

## Manual Download

If the script fails, you can manually:

1. Download the model from: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
2. Convert to CoreML using coremltools
3. Place the files in this directory

## Development Mode

If model files are not present, the embedding service will operate in "mock mode":
- Generates deterministic pseudo-embeddings based on text hash
- Useful for development and testing without the full model
- Actual embedding quality/accuracy is not available in mock mode

## Model Specifications

| Property | Value |
|----------|-------|
| Model | MiniLM-L6-v2 |
| Embedding Dimension | 384 |
| Max Sequence Length | 128 |
| Vocabulary Size | ~30,522 |
| Target Latency | <10ms (ANE) |
