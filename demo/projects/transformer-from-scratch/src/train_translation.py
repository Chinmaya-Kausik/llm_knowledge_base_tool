"""Train an encoder-decoder transformer on EN→DE translation.

Usage:
    cd projects/transformer-from-scratch/src
    python train_translation.py

Downloads Tatoeba EN-DE pairs on first run, builds word-level vocabs,
trains the same EncoderDecoder architecture used for sorting, and
evaluates with BLEU + example translations.
"""

import math
import yaml
import torch
import torch.nn as nn
from pathlib import Path
from collections import Counter
from torch.utils.data import DataLoader

from model import EncoderDecoder
from translation_data import prepare_data, collate_fn
from tokenizer import PAD, BOS, EOS
from lr_schedule import transformer_lr_scheduler

# ── Load config ──────────────────────────────────────────────
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"

with open(CONFIG_PATH) as f:
    cfg = yaml.safe_load(f)

model_cfg = cfg["model"]
train_cfg = cfg.get("translation", cfg["training"])  # fall back to training

device = "cuda" if torch.cuda.is_available() else "cpu"

# ── Prepare data ─────────────────────────────────────────────
print("=" * 60)
print("  Transformer Translation: EN → DE")
print("=" * 60)

train_ds, val_ds, src_tok, tgt_tok = prepare_data(
    max_pairs=train_cfg.get("max_pairs"),
    max_len_words=train_cfg.get("max_len_words", 25),
    max_len_tokens=train_cfg.get("max_len_tokens", 40),
    src_vocab_size=train_cfg.get("src_vocab_size", 8000),
    tgt_vocab_size=train_cfg.get("tgt_vocab_size", 8000),
    val_split=train_cfg.get("val_split", 0.05),
)

# ── Build model ──────────────────────────────────────────────
model = EncoderDecoder(
    src_vocab=src_tok.vocab_size,
    tgt_vocab=tgt_tok.vocab_size,
    d_model=model_cfg["d_model"],
    n_heads=model_cfg["n_heads"],
    enc_layers=model_cfg["enc_layers"],
    dec_layers=model_cfg["dec_layers"],
    d_ff=model_cfg["d_ff"],
    dropout=model_cfg.get("dropout", 0.1),
    max_len=model_cfg.get("max_len", 128),
).to(device)

param_count = sum(p.numel() for p in model.parameters())
print(f"\nModel: {param_count:,} parameters | device={device}")
print(f"  d_model={model_cfg['d_model']}, n_heads={model_cfg['n_heads']}, "
      f"enc={model_cfg['enc_layers']}L, dec={model_cfg['dec_layers']}L")

# ── Dataloaders ──────────────────────────────────────────────
batch_size = train_cfg.get("batch_size", 64)

train_loader = DataLoader(train_ds, batch_size=batch_size,
                          shuffle=True, collate_fn=collate_fn)
val_loader = DataLoader(val_ds, batch_size=batch_size,
                        shuffle=False, collate_fn=collate_fn)


def infinite(loader):
    while True:
        yield from loader


# ── Training setup ───────────────────────────────────────────
warmup_steps = train_cfg.get("warmup_steps", 2000)
if warmup_steps > 0:
    # Transformer schedule: base LR = 1.0, scheduler computes actual LR
    optimizer = torch.optim.Adam(model.parameters(), lr=1.0,
                                 betas=(0.9, 0.98), eps=1e-9)
    scheduler = transformer_lr_scheduler(optimizer, model_cfg["d_model"], warmup_steps)
    lr = f"warmup({warmup_steps})+inv-sqrt"
else:
    lr = train_cfg.get("learning_rate", 3e-4)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    scheduler = None
loss_fn = nn.CrossEntropyLoss(ignore_index=PAD)

steps = train_cfg.get("steps", 15000)
log_every = train_cfg.get("log_every", 100)
eval_every = train_cfg.get("eval_every", 1000)
max_gen_len = train_cfg.get("max_len_tokens", 40) + 5


# ── BLEU scoring ────────────────────────────────────────────

def ngram_counts(tokens: list, n: int) -> Counter:
    return Counter(tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1))


def sentence_bleu(reference: list, hypothesis: list, max_n: int = 4) -> float:
    """Compute sentence-level BLEU (smoothed) for a single pair."""
    if len(hypothesis) == 0:
        return 0.0

    # Brevity penalty
    bp = min(1.0, math.exp(1 - len(reference) / len(hypothesis))) if len(hypothesis) > 0 else 0.0

    log_bleu = 0.0
    for n in range(1, max_n + 1):
        ref_counts = ngram_counts(reference, n)
        hyp_counts = ngram_counts(hypothesis, n)
        clipped = sum(min(hyp_counts[ng], ref_counts[ng]) for ng in hyp_counts)
        total = max(len(hypothesis) - n + 1, 1)
        # +1 smoothing to avoid log(0)
        precision = (clipped + 1) / (total + 1)
        log_bleu += math.log(precision) / max_n

    return bp * math.exp(log_bleu)


def corpus_bleu(references: list[list], hypotheses: list[list]) -> float:
    """Average sentence-level BLEU over a corpus."""
    if not references:
        return 0.0
    return sum(sentence_bleu(r, h) for r, h in zip(references, hypotheses)) / len(references)


# ── Decode helpers ──────────────────────────────────────────

def ids_to_words(ids: torch.Tensor, tok) -> list[str]:
    """Convert tensor of IDs to list of word strings (no special tokens)."""
    words = []
    for i in ids.tolist():
        if i in (PAD, BOS, EOS):
            if i == EOS:
                break
            continue
        words.append(tok.id2word.get(i, "<unk>"))
    return words


# ── Evaluation ──────────────────────────────────────────────

@torch.no_grad()
def evaluate(model, loader, n_show=5):
    """Greedy-decode the val set; report BLEU and show examples."""
    model.eval()
    all_refs, all_hyps, examples = [], [], []

    for src, tgt_input, tgt_label, src_mask, tgt_mask in loader:
        src, tgt_label = src.to(device), tgt_label.to(device)
        src_mask = src_mask.to(device)

        preds = model.generate(src, max_len=max_gen_len,
                               bos_token=BOS, eos_token=EOS,
                               src_mask=src_mask)

        for i in range(src.size(0)):
            ref_words = ids_to_words(tgt_label[i], tgt_tok)
            hyp_words = ids_to_words(preds[i], tgt_tok)
            all_refs.append(ref_words)
            all_hyps.append(hyp_words)

            if len(examples) < n_show:
                src_words = ids_to_words(src[i], src_tok)
                examples.append((src_words, ref_words, hyp_words))

    bleu = corpus_bleu(all_refs, all_hyps)
    print(f"  Val BLEU: {bleu:.4f}  ({len(all_refs)} pairs)")

    for src_w, ref_w, hyp_w in examples:
        print(f"    EN:  {' '.join(src_w)}")
        print(f"    REF: {' '.join(ref_w)}")
        print(f"    HYP: {' '.join(hyp_w)}")
        print()

    model.train()
    return bleu


# ── Training loop ────────────────────────────────────────────
print(f"\nTraining for {steps} steps  (batch_size={batch_size}, lr={lr})\n")

train_iter = infinite(train_loader)
running_loss = 0.0

for step in range(1, steps + 1):
    src, tgt_input, tgt_label, src_mask, tgt_mask = next(train_iter)
    src = src.to(device)
    tgt_input = tgt_input.to(device)
    tgt_label = tgt_label.to(device)
    src_mask = src_mask.to(device)
    tgt_mask = tgt_mask.to(device)

    logits = model(src, tgt_input, src_mask=src_mask, tgt_mask=tgt_mask)
    loss = loss_fn(logits.view(-1, tgt_tok.vocab_size), tgt_label.view(-1))

    optimizer.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    optimizer.step()
    if scheduler is not None:
        scheduler.step()

    running_loss += loss.item()

    if step % log_every == 0:
        avg_loss = running_loss / log_every
        current_lr = optimizer.param_groups[0]["lr"]
        print(f"Step {step:>5d}/{steps}  Loss: {avg_loss:.4f}  LR: {current_lr:.6f}")
        running_loss = 0.0

    if step % eval_every == 0:
        evaluate(model, val_loader)
        print()

# Final eval
print("\n" + "=" * 60)
print("  Final evaluation")
print("=" * 60)
evaluate(model, val_loader, n_show=8)

# Save checkpoint
ckpt_dir = Path(__file__).resolve().parent.parent / "checkpoints"
ckpt_dir.mkdir(parents=True, exist_ok=True)
ckpt_path = ckpt_dir / "translation_model.pt"
torch.save({
    "model_state_dict": model.state_dict(),
    "src_vocab_size": src_tok.vocab_size,
    "tgt_vocab_size": tgt_tok.vocab_size,
    "model_cfg": model_cfg,
    "step": steps,
}, ckpt_path)
print(f"\nCheckpoint saved to {ckpt_path}")
print("Done.")
