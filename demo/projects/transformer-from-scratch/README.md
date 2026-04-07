---
tags:
- code
- transformers
title: Transformer From Scratch
type: project
---

# Transformer From Scratch

Minimal PyTorch implementation of the [[Transformer Architecture]].

## Files
- `attention.py` — [[Self-Attention]], [[Multi-Head Attention]], causal masking, and [[Cross-Attention]]
- `model.py` — encoder, decoder, and full encoder-decoder transformer
- `data.py` — synthetic sorting dataset (random ints → sorted)
- `train.py` — seq2seq training loop with teacher forcing + greedy eval
- `tokenizer.py` — word-level tokenizer built from scratch (encode/decode/persist)
- `translation_data.py` — downloads Tatoeba EN→DE pairs, builds vocabs, PyTorch Dataset
- `train_translation.py` — translation training loop with BLEU evaluation
- `lr_schedule.py` — Transformer warmup + inverse-sqrt-decay LR schedule
- `config.yaml` — hyperparameters (sorting + translation sections)

## Status
✅ Sorting task — fully working encoder-decoder training.
✅ EN→DE translation — real tokenized data via Tatoeba, word-level tokenizer, BLEU eval.
✅ LR warmup schedule — "Attention Is All You Need" warmup + inv-sqrt decay, both scripts.
Next: subword tokenization (BPE), beam search decoding.

## Uses
- [[Attention Mechanisms]]
- [[Transformer Architecture]]
