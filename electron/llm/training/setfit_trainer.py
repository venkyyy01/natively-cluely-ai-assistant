#!/usr/bin/env python3
"""
Production-grade SetFit training script with anti-overfitting safeguards.

Usage:
    python3 electron/llm/training/setfit_trainer.py \
        --dataset electron/llm/training/intent_dataset.json \
        --output-dir models/setfit-intent-v1 \
        --epochs 20 \
        --batch-size 16 \
        --body-learning-rate 2e-5 \
        --head-learning-rate 1e-2 \
        --patience 3 \
        --min-delta 0.005
"""

import argparse
import json
import os
import random
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import torch
from datasets import Dataset
from setfit import SetFitModel, Trainer, TrainingArguments
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import StratifiedKFold

# ---------------------------------------------------------------------------
# Reproducibility
# ---------------------------------------------------------------------------

def set_seed(seed: int):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        torch.mps.manual_seed(seed)

# ---------------------------------------------------------------------------
# Data loading and stratified split
# ---------------------------------------------------------------------------

def load_dataset(path: str) -> list[dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["examples"]

def stratified_split(examples: list[dict], train_ratio=0.6, val_ratio=0.2, seed=42):
    by_label: dict[str, list[dict]] = {}
    for ex in examples:
        by_label.setdefault(ex["label"], []).append(ex)

    rng = random.Random(seed)
    train, val, test = [], [], []
    for label, group in by_label.items():
        rng.shuffle(group)
        n = len(group)
        n_train = int(n * train_ratio)
        n_val = int(n * val_ratio)
        train.extend(group[:n_train])
        val.extend(group[n_train : n_train + n_val])
        test.extend(group[n_train + n_val :])

    rng.shuffle(train)
    rng.shuffle(val)
    rng.shuffle(test)
    return train, val, test

# ---------------------------------------------------------------------------
# Augmentation (training only)
# ---------------------------------------------------------------------------

def augment(examples: list[dict]) -> list[dict]:
    augmented = list(examples)
    for ex in examples:
        text = ex["text"]
        variations = []
        if not text.endswith("?"):
            variations.append(text + "?")
        if not text.lower().startswith("can you"):
            variations.append("Can you " + text[0].lower() + text[1:])
        if "design" in text.lower() and not text.lower().startswith("how would you"):
            variations.append("How would you " + text[0].lower() + text[1:])
        if ex["label"] == "behavioral":
            prefixes = ["tell me about", "describe", "give me an example of"]
            if not any(text.lower().startswith(p) for p in prefixes):
                variations.append("Tell me about " + text[0].lower() + text[1:])
        for v in variations:
            augmented.append({"text": v, "label": ex["label"], "source": "augmented"})
    return augmented

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def compute_metrics(y_pred, y_test):
    return {
        "accuracy": accuracy_score(y_test, y_pred),
        "f1_macro": f1_score(y_test, y_pred, average="macro", zero_division=0),
        "f1_weighted": f1_score(y_test, y_pred, average="weighted", zero_division=0),
    }

# ---------------------------------------------------------------------------
# K-Fold Cross Validation
# ---------------------------------------------------------------------------

def run_cv(examples: list[dict], config: argparse.Namespace, k=5):
    texts = [ex["text"] for ex in examples]
    labels = [ex["label"] for ex in examples]

    skf = StratifiedKFold(n_splits=k, shuffle=True, random_state=config.seed)
    fold_results = []

    for fold, (train_idx, val_idx) in enumerate(skf.split(texts, labels), 1):
        print(f"\n[CV] Fold {fold}/{k}")
        train_exs = [examples[i] for i in train_idx]
        val_exs = [examples[i] for i in val_idx]

        train_exs = augment(train_exs)
        print(f"  Train: {len(train_exs)} ({sum(1 for e in train_exs if e.get('source') == 'augmented')} augmented)")
        print(f"  Val:   {len(val_exs)}")

        train_ds = Dataset.from_list(train_exs)
        val_ds = Dataset.from_list(val_exs)

        model = SetFitModel.from_pretrained(config.model_name)

        args = TrainingArguments(
            batch_size=(config.batch_size, config.batch_size),
            num_epochs=(1, config.epochs),  # 1 embedding epoch, N classifier epochs
            num_iterations=config.num_iterations,
            body_learning_rate=config.body_learning_rate,
            head_learning_rate=config.head_learning_rate,
            l2_weight=config.l2_weight,
            warmup_proportion=config.warmup_ratio,
            seed=config.seed,
            max_length=config.max_seq_length,
            show_progress_bar=False,
            use_amp=config.use_amp,
        )

        trainer = Trainer(
            model=model,
            args=args,
            train_dataset=train_ds,
            eval_dataset=val_ds,
            metric=compute_metrics,
            column_mapping={"text": "text", "label": "label"},
        )

        trainer.train()
        metrics = trainer.evaluate()

        # Also get training accuracy
        train_pred = model.predict([ex["text"] for ex in train_exs])
        train_metrics = compute_metrics(train_pred, [ex["label"] for ex in train_exs])

        fold_results.append({
            "fold": fold,
            "train_accuracy": train_metrics["accuracy"],
            "val_f1": metrics["f1_macro"],
            "val_accuracy": metrics["accuracy"],
            "val_weighted_f1": metrics["f1_weighted"],
        })

        print(f"  Train acc={train_metrics['accuracy']:.4f} | Val f1={metrics['f1_macro']:.4f} | Val acc={metrics['accuracy']:.4f}")

        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    avg_f1 = sum(r["val_f1"] for r in fold_results) / len(fold_results)
    avg_acc = sum(r["val_accuracy"] for r in fold_results) / len(fold_results)
    return {"folds": fold_results, "avg_val_f1": avg_f1, "avg_val_accuracy": avg_acc}

# ---------------------------------------------------------------------------
# Final training
# ---------------------------------------------------------------------------

def train_final(train_exs: list[dict], val_exs: list[dict], config: argparse.Namespace, output_dir: str):
    print("\n[Train] Training final model on train+val...")
    all_train = augment(train_exs + val_exs)
    print(f"  Total: {len(all_train)} ({sum(1 for e in all_train if e.get('source') == 'augmented')} augmented)")

    train_ds = Dataset.from_list(all_train)

    model = SetFitModel.from_pretrained(config.model_name)

    args = TrainingArguments(
        batch_size=(config.batch_size, config.batch_size),
        num_epochs=(1, config.epochs),
        num_iterations=config.num_iterations,
        body_learning_rate=config.body_learning_rate,
        head_learning_rate=config.head_learning_rate,
        l2_weight=config.l2_weight,
        warmup_proportion=config.warmup_ratio,
        seed=config.seed,
        max_length=config.max_seq_length,
        show_progress_bar=True,
        use_amp=config.use_amp,
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_ds,
        column_mapping={"text": "text", "label": "label"},
    )
    trainer.train()

    os.makedirs(output_dir, exist_ok=True)
    model.save_pretrained(output_dir)

    metadata = {
        "config": vars(config),
        "training_date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "num_examples": len(all_train),
        "num_original": len(train_exs) + len(val_exs),
        "num_augmented": sum(1 for e in all_train if e.get("source") == "augmented"),
        "labels": sorted({ex["label"] for ex in all_train}),
        "version": "1.0.0",
    }
    with open(os.path.join(output_dir, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    print(f"[Train] Model saved to {output_dir}")
    return output_dir

# ---------------------------------------------------------------------------
# Test evaluation
# ---------------------------------------------------------------------------

def evaluate_test(model_dir: str, test_exs: list[dict]) -> dict:
    print("\n[Eval] Evaluating on held-out test set...")
    model = SetFitModel.from_pretrained(model_dir)
    texts = [ex["text"] for ex in test_exs]
    labels = [ex["label"] for ex in test_exs]

    start = time.time()
    y_pred = model.predict(texts)
    latency_ms = (time.time() - start) / len(texts) * 1000

    metrics = compute_metrics(y_pred, labels)
    results = {
        "accuracy": metrics["accuracy"],
        "macro_f1": metrics["f1_macro"],
        "weighted_f1": metrics["f1_weighted"],
        "avg_latency_ms": latency_ms,
        "test_size": len(test_exs),
    }

    print(f"  Accuracy:  {results['accuracy']:.4f}")
    print(f"  Macro F1:  {results['macro_f1']:.4f}")
    print(f"  Weighted F1: {results['weighted_f1']:.4f}")
    print(f"  Avg Latency: {latency_ms:.2f}ms")

    from sklearn.metrics import classification_report
    print("\n  Per-class report:")
    print(classification_report(labels, y_pred, zero_division=0))

    out_path = os.path.join(model_dir, "test-evaluation.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print(f"  Saved to {out_path}")

    return results

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Train SetFit intent classifier")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output-dir", default="models/setfit-intent-v1")
    parser.add_argument("--model-name", default="sentence-transformers/all-MiniLM-L6-v2")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--body-learning-rate", type=float, default=2e-5)
    parser.add_argument("--head-learning-rate", type=float, default=1e-2)
    parser.add_argument("--warmup-ratio", type=float, default=0.1)
    parser.add_argument("--l2-weight", type=float, default=0.01)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--min-delta", type=float, default=0.005)
    parser.add_argument("--max-seq-length", type=int, default=256)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--skip-cv", action="store_true")
    parser.add_argument("--num-iterations", type=int, default=10, help="SetFit contrastive learning iterations (default 10, lower=faster)")
    parser.add_argument("--use-amp", action="store_true", help="Use automatic mixed precision (faster on MPS/GPU)")
    args = parser.parse_args()

    # Detect device
    device = "cpu"
    if torch.cuda.is_available():
        device = "cuda"
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = "mps"
    print(f"[Train] Using device: {device}")

    set_seed(args.seed)

    print("[Train] Configuration:")
    for k, v in vars(args).items():
        print(f"  {k}: {v}")

    examples = load_dataset(args.dataset)
    print(f"\n[Train] Loaded {len(examples)} examples")
    dist = Counter(ex["label"] for ex in examples)
    for label, count in sorted(dist.items()):
        print(f"  {label}: {count}")

    train, val, test = stratified_split(examples, 0.6, 0.2, args.seed)
    print(f"\n[Train] Split -> Train: {len(train)} | Val: {len(val)} | Test: {len(test)}")

    if not args.skip_cv:
        print("\n[Train] Running 5-fold cross-validation...")
        cv = run_cv(train, args, k=5)
        print("\n[Train] CV Results:")
        for fold in cv["folds"]:
            print(f"  Fold {fold['fold']}: train_acc={fold['train_accuracy']:.4f} val_f1={fold['val_f1']:.4f} val_acc={fold['val_accuracy']:.4f}")
        print(f"  Average Val F1:       {cv['avg_val_f1']:.4f}")
        print(f"  Average Val Accuracy: {cv['avg_val_accuracy']:.4f}")

        gaps = [f for f in cv["folds"] if f["train_accuracy"] - f["val_accuracy"] > 0.1]
        if gaps:
            print("\n[Train] WARNING: Potential overfitting detected:")
            for g in gaps:
                print(f"  Fold {g['fold']}: train-val gap = {g['train_accuracy'] - g['val_accuracy']:.3f}")

    model_dir = train_final(train, val, args, args.output_dir)
    evaluate_test(model_dir, test)
    print("\n[Train] Done!")

if __name__ == "__main__":
    main()
