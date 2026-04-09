---
tags:
- machine-learning
- optimization
title: Regularization
type: concept
---

# Regularization

Techniques to prevent overfitting.

## Methods
- **Dropout** — randomly zero activations during training
- **Weight decay** — L2 penalty on parameters
- **Data augmentation** — more varied training data
- **Early stopping** — stop before overfitting

## In Transformers
[[Transformer Architecture]] uses dropout in attention and feed-forward layers.
[[BERT]] also uses masking as implicit regularization.
