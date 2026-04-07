---
tags:
- machine-learning
- optimization
title: Loss Functions
type: concept
---

# Loss Functions

Quantify how wrong the model's predictions are.

## Common Loss Functions
- **Cross-Entropy** — classification (used in [[BERT]], [[GPT]])
- **MSE** — regression
- **Contrastive Loss** — representation learning
- **KL Divergence** — distribution matching (used in RLHF)

## Connection to Training
Loss is what [[Gradient Descent]] minimizes via [[Backpropagation]].
