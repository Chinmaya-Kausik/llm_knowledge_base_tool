---
tags:
- nlp
- machine-learning
title: Tokenization
type: concept
---

# Tokenization

Breaking text into tokens that the model processes.

## Methods
- **BPE** (Byte Pair Encoding) — used by [[GPT]]
- **WordPiece** — used by [[BERT]]
- **SentencePiece** — language-agnostic
- **Byte-level** — handles any Unicode

## Vocabulary Size
Typical: 30K-100K tokens. Tradeoff: larger vocab = shorter sequences but bigger embedding table.

## Impact on [[Attention Mechanisms]]
Sequence length after tokenization determines the O(n²) cost of [[Self-Attention]].
