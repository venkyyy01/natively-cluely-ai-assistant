#!/bin/bash
# scripts/download-models.sh
#
# Downloads MiniLM-L6-v2 ONNX model and vocabulary for ANE embeddings.
# The model is converted to CoreML format for Neural Engine acceleration.
#
# Requirements:
# - Python 3.8+ with pip
# - Xcode Command Line Tools (for coremltools)
#
# Usage:
#   ./scripts/download-models.sh
#
# Output:
#   swift-host/NativelyHost/Resources/models/minilm-l6-v2.mlmodelc
#   swift-host/NativelyHost/Resources/models/vocab.txt

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MODELS_DIR="$PROJECT_ROOT/swift-host/NativelyHost/Resources/models"
TEMP_DIR="$PROJECT_ROOT/.model-download-temp"

echo "=== MiniLM-L6-v2 Model Download Script ==="
echo ""
echo "This script downloads and converts the MiniLM-L6-v2 model for ANE embeddings."
echo ""

# Create directories
mkdir -p "$MODELS_DIR"
mkdir -p "$TEMP_DIR"

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is required but not found."
    echo "Please install Python 3.8 or later."
    exit 1
fi

echo "Step 1: Installing Python dependencies..."
pip3 install --quiet transformers torch onnx coremltools

echo "Step 2: Downloading model and vocabulary..."
python3 << 'PYTHON_SCRIPT'
import os
import sys

TEMP_DIR = os.environ.get('TEMP_DIR', '.model-download-temp')
MODELS_DIR = os.environ.get('MODELS_DIR', 'swift-host/NativelyHost/Resources/models')

try:
    from transformers import AutoTokenizer, AutoModel
    import torch
    import coremltools as ct
    
    print("  Downloading MiniLM-L6-v2 from Hugging Face...")
    
    # Download model and tokenizer
    model_name = "sentence-transformers/all-MiniLM-L6-v2"
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModel.from_pretrained(model_name)
    
    # Save vocabulary
    vocab_path = os.path.join(MODELS_DIR, "vocab.txt")
    tokenizer.save_vocabulary(MODELS_DIR)
    print(f"  Saved vocabulary to {vocab_path}")
    
    # Export to ONNX first
    print("  Converting model to ONNX format...")
    onnx_path = os.path.join(TEMP_DIR, "minilm-l6-v2.onnx")
    
    dummy_input = tokenizer(
        "This is a test sentence.",
        return_tensors="pt",
        padding="max_length",
        truncation=True,
        max_length=128
    )
    
    model.eval()
    
    torch.onnx.export(
        model,
        (dummy_input["input_ids"], dummy_input["attention_mask"]),
        onnx_path,
        input_names=["input_ids", "attention_mask"],
        output_names=["last_hidden_state"],
        dynamic_axes={
            "input_ids": {0: "batch_size"},
            "attention_mask": {0: "batch_size"},
            "last_hidden_state": {0: "batch_size"}
        },
        opset_version=14
    )
    print(f"  Saved ONNX model to {onnx_path}")
    
    # Convert to CoreML
    print("  Converting to CoreML format (this may take a few minutes)...")
    
    import onnx
    from onnx import numpy_helper
    
    onnx_model = onnx.load(onnx_path)
    
    mlmodel = ct.converters.onnx.convert(
        model=onnx_path,
        minimum_deployment_target=ct.target.macOS12,
        compute_units=ct.ComputeUnit.CPU_AND_NE,  # Neural Engine
    )
    
    # Save as mlpackage
    mlpackage_path = os.path.join(MODELS_DIR, "minilm-l6-v2.mlpackage")
    mlmodel.save(mlpackage_path)
    print(f"  Saved CoreML model to {mlpackage_path}")
    
    print("")
    print("SUCCESS: Model downloaded and converted!")
    print(f"  Vocabulary: {vocab_path}")
    print(f"  Model: {mlpackage_path}")
    print("")
    print("Note: The model will be compiled to .mlmodelc at build time.")
    
except ImportError as e:
    print(f"ERROR: Missing Python package: {e}")
    print("Please install required packages: pip3 install transformers torch onnx coremltools")
    sys.exit(1)
except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)
PYTHON_SCRIPT

# Cleanup
echo "Step 3: Cleaning up temporary files..."
rm -rf "$TEMP_DIR"

echo ""
echo "=== Download Complete ==="
echo ""
echo "Model files are located at:"
echo "  $MODELS_DIR/"
echo ""
echo "To verify the installation, run:"
echo "  cd swift-host && swift build"
echo ""
echo "Note: The Swift app will use mock embeddings if model files are not found."
