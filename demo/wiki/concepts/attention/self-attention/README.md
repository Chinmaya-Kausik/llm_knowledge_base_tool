---
tags:
- attention
title: Self-Attention
type: concept
---

# Self-Attention

Each token attends to every other token: Attention(Q,K,V) = softmax(QK^T/sqrt(d_k)) * V

## Complexity
O(n^2 * d) — quadratic in sequence length.

## See Also
- [[Multi-Head Attention]]
- [[Transformer Architecture]]
