---
tags:
- attention
- efficiency
title: FlashAttention
type: summary
---

# FlashAttention: Fast and Memory-Efficient Attention

Optimizes [[Self-Attention]] at the hardware level.

## Problem
Standard attention materializes the n×n attention matrix — O(n²) memory.

## Solution
Tile the computation to fit in GPU SRAM. Never materialize the full matrix.
IO-aware algorithm that minimizes memory reads/writes.

## Results
- 2-4x faster than standard PyTorch attention
- Enables longer sequences (up to 64K tokens)
- Used in all modern [[Transformer Architecture]] implementations

## Connection to Vault
The [[Research Paper Draft]] project builds on FlashAttention ideas for efficient attention.
