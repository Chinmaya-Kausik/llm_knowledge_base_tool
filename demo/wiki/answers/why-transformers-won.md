---
tags:
- transformers
- architecture
title: Why Did Transformers Win?
type: answer
---

# Why Did Transformers Win?

**Q:** Why did transformers replace RNNs and LSTMs?

1. **Parallelization**: [[Self-Attention]] processes all positions simultaneously. RNNs process sequentially.
2. **Long-range dependencies**: Attention connects any two positions directly. RNNs struggle beyond ~100 tokens.
3. **Scaling**: [[Transformer Architecture]] scales predictably with compute (scaling laws).
4. **Transfer learning**: Pre-trained transformers ([[BERT]], [[GPT]]) transfer well to downstream tasks.
5. **Hardware fit**: Matrix multiplications are GPU-friendly. Attention is mostly matmul.

The key insight from "[[Attention Is All You Need]]" was that recurrence was unnecessary.
