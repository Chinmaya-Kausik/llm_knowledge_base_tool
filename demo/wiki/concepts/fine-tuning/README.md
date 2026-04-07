---
tags:
- machine-learning
- nlp
title: Fine-tuning
type: concept
---

# Fine-tuning

Adapting a pre-trained model to a specific task.

## Methods
- **Full fine-tuning** — update all parameters
- **LoRA** — low-rank adaptation, only train small matrices
- **Prompt tuning** — learn soft prompt vectors
- **RLHF** — [[Reinforcement Learning]] from Human Feedback (used for [[GPT]]/Claude alignment)

## Pre-trained Models
Start from [[BERT]] or [[GPT]], fine-tune on your data.
Much less data needed than training from scratch.
