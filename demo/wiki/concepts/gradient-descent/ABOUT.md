---
tags:
- optimization
- machine-learning
title: Gradient Descent
type: concept
---

# Gradient Descent

Iterative optimization algorithm. Updates parameters in the direction of steepest decrease of the loss function.

## Variants
- **SGD** — stochastic, one sample at a time
- **Mini-batch** — small batches, best of both worlds
- **Adam** — adaptive learning rates per parameter, most popular

## Learning Rate
Too high → diverge. Too low → stuck. Learning rate schedulers help:
- Cosine annealing
- Warmup + decay
- [[Reinforcement Learning]] uses different optimization (policy gradient)

## Connection to [[Transformer Architecture]]
Transformers are trained with Adam optimizer + warmup schedule.
