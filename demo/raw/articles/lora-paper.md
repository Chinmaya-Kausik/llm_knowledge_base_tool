---
tags:
- fine-tuning
- efficiency
title: 'LoRA: Low-Rank Adaptation'
type: summary
---

# LoRA: Low-Rank Adaptation of Large Language Models

Efficient [[Fine-tuning]] method.

## Key Idea
Instead of updating all weights W, decompose the update as W + BA where B and A are low-rank matrices.
Only train B and A — much fewer parameters.

## Results
- 10,000x fewer trainable parameters than full fine-tuning
- Comparable performance on most tasks
- Can merge into base model at inference (no latency cost)

## Impact
Made fine-tuning accessible on consumer GPUs.
Led to explosion of community-fine-tuned models.
