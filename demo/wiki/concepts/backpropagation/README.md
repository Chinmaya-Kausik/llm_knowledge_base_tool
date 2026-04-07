---
tags:
- machine-learning
- optimization
title: Backpropagation
type: concept
---

# Backpropagation

Chain rule applied to compute gradients through a computation graph.

## How it works
1. Forward pass: compute output
2. Compute loss
3. Backward pass: compute gradients via chain rule
4. Update weights via [[Gradient Descent]]

## Vanishing/Exploding Gradients
Deep networks suffer from gradients shrinking/growing exponentially.
Solutions: residual connections ([[Transformer Architecture]]), layer norm, careful initialization.
