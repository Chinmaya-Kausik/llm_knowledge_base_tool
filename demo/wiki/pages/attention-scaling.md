---
tags:
- attention
- scalability
title: How Does Attention Scale?
type: answer
---

# How Does Attention Scale?

**Q:** What are the computational costs of [[Self-Attention]]?

O(n^2 * d) time. For 512 tokens with d=768: ~150M FLOPs per layer, ~1.8B for 12 layers.
[[Multi-Head Attention]] splits d into heads but total FLOPs stay similar.
