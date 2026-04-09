---
tags:
- code
- data
- python
title: Data Pipeline
type: project
---

# Data Pipeline

ETL pipeline for processing research datasets.

## Architecture
- `ingest.py` — fetch data from APIs
- `transform.py` — clean, normalize, tokenize
- `export.py` — save to parquet format
- `config.yaml` — pipeline configuration

## Status
Working on ingestion. Next: add [[Tokenization]] stage.

## Uses
- [[Embeddings]] for vector representations
- [[Tokenization]] for text processing
