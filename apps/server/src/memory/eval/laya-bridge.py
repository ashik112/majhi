"""Laya for the scope eval: one JSON request per line on stdin, one answer per line on stdout.

Run with the venv majhi's host helper installed (~/.majhi/laya/venv/bin/python), HF_HOME set to
~/.majhi/laya/hf. Each line is {"state": "...", "questions": {...}} as layad.py's /predict takes.
"""

import json
import os
import sys

import laya_mlx as laya

agent = laya.load(os.environ.get("MAJHI_LAYA_MODEL", "aac6fef/laya-mlx"))
for line in sys.stdin:
    if not line.strip():
        continue
    body = json.loads(line)
    result = agent.predict(body["state"], body["questions"])
    sys.stdout.write(json.dumps({"answers": result["answers"]}) + "\n")
    sys.stdout.flush()
