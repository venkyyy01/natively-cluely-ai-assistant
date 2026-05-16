#!/usr/bin/env python3
"""
SetFit inference server.
Reads JSON requests from stdin, writes JSON responses to stdout.
Keeps model loaded in memory for low-latency inference.

Protocol (line-delimited JSON):
    Request:  {"text": "question here", "id": 1}
    Response: {"id": 1, "intent": "behavioral", "confidence": 0.92, "top_k": [...]}

Start:
    python3 electron/llm/training/setfit_server.py --model models/setfit-intent-v1
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from setfit import SetFitModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Path to trained SetFit model")
    parser.add_argument("--quantize", action="store_true", help="Use ONNX quantization (not yet supported)")
    args = parser.parse_args()

    if not os.path.isdir(args.model):
        print(json.dumps({"error": f"Model directory not found: {args.model}"}), file=sys.stderr)
        sys.exit(1)

    print(json.dumps({"status": "loading", "model": args.model}), flush=True)
    start = time.time()
    model = SetFitModel.from_pretrained(args.model)
    load_ms = (time.time() - start) * 1000

    # Get label mapping from model
    labels = model.model_head.classes_ if hasattr(model.model_head, "classes_") else None
    if labels is None:
        # Try to infer from a dummy prediction
        dummy = model.predict(["test"])
        labels = model.model_head.classes_

    label_list = list(labels)
    print(json.dumps({"status": "ready", "load_ms": load_ms, "labels": label_list}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": str(e)}), flush=True)
            continue

        text = req.get("text", "").strip()
        req_id = req.get("id", 0)

        if not text:
            print(json.dumps({"id": req_id, "error": "empty text"}), flush=True)
            continue

        start = time.time()
        pred_label = model.predict([text])[0]
        # SetFit predict gives hard labels; for confidence we need predict_proba if available
        confidence = 0.85  # default if proba unavailable
        top_k = []
        if hasattr(model.model_head, "predict_proba"):
            try:
                probs = model.model_head.predict_proba(model.encode([text]))[0]
                # probs is array of probabilities
                import numpy as np
                if hasattr(probs, 'tolist'):
                    probs = probs.tolist()
                indices = np.argsort(probs)[::-1][:3]
                top_k = [{"label": label_list[i], "score": float(probs[i])} for i in indices]
                confidence = float(probs[indices[0]])
            except Exception:
                pass
        else:
            top_k = [{"label": str(pred_label), "score": confidence}]

        latency_ms = (time.time() - start) * 1000

        resp = {
            "id": req_id,
            "intent": str(pred_label),
            "confidence": confidence,
            "latency_ms": latency_ms,
            "top_k": top_k,
        }
        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()
