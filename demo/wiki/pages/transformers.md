---
status: compiled
tags:
- machine-learning
- architecture
title: Transformer Architecture
type: concept
summary: "Neural network architecture based on self-attention, replacing RNNs for sequence tasks"
---

# Transformer Architecture

The dominant architecture for sequence modeling since 2017.

## Components
- [[Self-Attention]] layers — the core mechanism
- Feed-forward networks (per-position)
- Layer normalization + residual connections

## Variants
- Encoder-only: [[BERT]]
- Decoder-only: [[GPT]]
- Encoder-decoder: T5, BART
