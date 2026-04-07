"""Export processed data to various formats."""
import json
import csv
from pathlib import Path

def to_jsonl(records, path):
    """Export to JSON Lines format."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for record in records:
            f.write(json.dumps(record) + "\n")

def to_csv(records, path, fields=None):
    """Export to CSV."""
    if not records:
        return
    fields = fields or list(records[0].keys())
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(records)
