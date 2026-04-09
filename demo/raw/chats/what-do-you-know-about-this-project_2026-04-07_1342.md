# Chat — 2026-04-07 13:42
Session: 1b28e13c-2869-486b-9208-37d2756b3762

## You

what do you know about this project

<details>
<summary>Thought</summary>

The user is asking what I know about the project. They're viewing the "transformer-from-scratch" project. Let me share what I know from context.The user is asking what I know about the project. They're viewing the "transformer-from-scratch" project. Let me share what I know from context.

</details>

## Claude

Based on the project page and my memory:

**Transformer From Scratch** — a minimal PyTorch encoder-decoder implementation for your attention efficiency paper (deadline mid-May).

**What's done:**
- Self-attention, multi-head attention, cross-attention, causal masking (`attention.py`)
- Full encoder-decoder model (`model.py`)
- Synthetic sorting task — working end-to-end
- EN→DE translation via Tatoeba with word-level tokenizer and BLEU eval
- LR warmup + inverse-sqrt-decay schedule (tuned to **3e-4**)
- Config-driven via `config.yaml`

**What's next:**
- Subword tokenization (BPE)
- Beam search decoding

**Key details:**
- Uses AdamW optimizer with custom warmup cosine schedule
- Experiments feed into your research paper results
- Learning rate was specifically tuned to 3e-4 (from prior work together)

Want me to dig into any of the files or help with the next steps (BPE or beam search)?
