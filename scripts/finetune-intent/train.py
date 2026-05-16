"""
train.py
Fine-tune DeBERTa-v3-small for interview intent classification on Apple MPS.
Uses HuggingFace Transformers + accelerate.
After training, export to ONNX via:
  optimum-cli export onnx --model <output_dir> --task text-classification --opset 14 <onnx_output_dir>
"""

import json
import argparse
from pathlib import Path

import torch
from torch.utils.data import Dataset, DataLoader
from transformers import (
    AutoTokenizer,
    AutoModelForSequenceClassification,
    TrainingArguments,
    Trainer,
    EarlyStoppingCallback,
)
from sklearn.metrics import classification_report, f1_score, accuracy_score

INTENT_LABELS = [
    "clarification",
    "follow_up",
    "deep_dive",
    "behavioral",
    "example_request",
    "summary_probe",
    "coding",
    "general",
]

LABEL2ID = {label: i for i, label in enumerate(INTENT_LABELS)}
ID2LABEL = {i: label for i, label in enumerate(INTENT_LABELS)}

MODEL_NAME = "cross-encoder/nli-deberta-v3-small"


class IntentDataset(Dataset):
    def __init__(self, data: list[dict], tokenizer, max_length: int = 128):
        self.texts = [d["text"] for d in data]
        self.labels = [d["label"] for d in data]
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self):
        return len(self.texts)

    def __getitem__(self, idx):
        encoding = self.tokenizer(
            self.texts[idx],
            truncation=True,
            padding="max_length",
            max_length=self.max_length,
            return_tensors="pt",
        )
        return {
            "input_ids": encoding["input_ids"].squeeze(0),
            "attention_mask": encoding["attention_mask"].squeeze(0),
            "labels": torch.tensor(self.labels[idx], dtype=torch.long),
        }


def compute_metrics(eval_pred):
    logits, labels = eval_pred
    preds = logits.argmax(axis=-1)
    acc = accuracy_score(labels, preds)
    f1_macro = f1_score(labels, preds, average="macro")
    f1_weighted = f1_score(labels, preds, average="weighted")
    return {"accuracy": acc, "f1_macro": f1_macro, "f1_weighted": f1_weighted}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=3e-5)
    parser.add_argument("--max-length", type=int, default=128)
    parser.add_argument("--output-dir", type=str, default=None)
    args = parser.parse_args()

    data_dir = Path(__file__).parent / "data"
    output_dir = args.output_dir or str(Path(__file__).parent / "output")

    with open(data_dir / "train.json") as f:
        train_data = json.load(f)
    with open(data_dir / "val.json") as f:
        val_data = json.load(f)

    print(f"Train: {len(train_data)}, Val: {len(val_data)}")

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_NAME,
        num_labels=len(INTENT_LABELS),
        id2label=ID2LABEL,
        label2id=LABEL2ID,
        ignore_mismatched_sizes=True,
    )

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Using device: {device}")

    train_dataset = IntentDataset(train_data, tokenizer, args.max_length)
    val_dataset = IntentDataset(val_data, tokenizer, args.max_length)

    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        weight_decay=0.01,
        warmup_ratio=0.1,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="f1_macro",
        greater_is_better=True,
        logging_steps=20,
        fp16=False,
        use_mps_device=(device == "mps"),
        report_to="none",
        dataloader_num_workers=0,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        compute_metrics=compute_metrics,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=3)],
    )

    print("Starting training...")
    trainer.train()

    print("\nEvaluating on validation set...")
    metrics = trainer.evaluate()
    print(f"Val accuracy: {metrics['eval_accuracy']:.4f}")
    print(f"Val F1 macro: {metrics['eval_f1_macro']:.4f}")
    print(f"Val F1 weighted: {metrics['eval_f1_weighted']:.4f}")

    print("\nPer-class report:")
    preds_output = trainer.predict(val_dataset)
    preds = preds_output.predictions.argmax(axis=-1)
    labels = preds_output.label_ids
    print(classification_report(labels, preds, target_names=INTENT_LABELS))

    final_dir = Path(output_dir) / "final"
    trainer.save_model(str(final_dir))
    tokenizer.save_pretrained(str(final_dir))
    print(f"\nModel saved to {final_dir}")

    with open(final_dir / "label_map.json", "w") as f:
        json.dump(ID2LABEL, f, indent=2)

    print("\nTo export ONNX, run:")
    print(
        f"  optimum-cli export onnx --model {final_dir} --task text-classification --opset 14 {Path(__file__).parent / 'onnx-output'}"
    )


if __name__ == "__main__":
    main()
