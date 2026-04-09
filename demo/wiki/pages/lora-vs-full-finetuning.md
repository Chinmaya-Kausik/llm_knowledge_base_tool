---
tags:
- fine-tuning
title: LoRA vs Full Fine-tuning
type: answer
---

# LoRA vs Full Fine-tuning

**Q:** When should I use LoRA vs full fine-tuning?

## LoRA
- Trains ~0.1% of parameters (low-rank matrices)
- Much faster, less GPU memory
- Good for adapting to similar domains
- Can merge multiple LoRA adapters

## Full Fine-tuning
- Trains all parameters
- Better performance ceiling
- More data needed
- Risk of catastrophic forgetting

**Rule of thumb**: Start with LoRA. Only use full fine-tuning if LoRA performance plateaus and you have enough data.

Related: [[Fine-tuning]], [[Gradient Descent]]
