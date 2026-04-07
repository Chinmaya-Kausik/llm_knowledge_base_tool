"""Train an encoder-decoder transformer on a synthetic sorting task."""

import yaml
import torch
import torch.nn as nn
from pathlib import Path
from torch.utils.data import DataLoader

from model import EncoderDecoder
from data import SortingDataset, collate_fn, PAD, BOS, EOS
from lr_schedule import transformer_lr_scheduler

# ── Load config ──────────────────────────────────────────────
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"

with open(CONFIG_PATH) as f:
    cfg = yaml.safe_load(f)

model_cfg = cfg["model"]
train_cfg = cfg["training"]

device = "cuda" if torch.cuda.is_available() else "cpu"

# ── Build model ──────────────────────────────────────────────
model = EncoderDecoder(
    src_vocab=model_cfg["vocab_size"],
    tgt_vocab=model_cfg["vocab_size"],
    d_model=model_cfg["d_model"],
    n_heads=model_cfg["n_heads"],
    enc_layers=model_cfg["enc_layers"],
    dec_layers=model_cfg["dec_layers"],
    d_ff=model_cfg["d_ff"],
    dropout=model_cfg.get("dropout", 0.1),
    max_len=model_cfg.get("max_len", 128),
).to(device)

param_count = sum(p.numel() for p in model.parameters())
print(f"Model: {param_count:,} parameters | device={device}")
print(f"  d_model={model_cfg['d_model']}, n_heads={model_cfg['n_heads']}, "
      f"enc={model_cfg['enc_layers']}L, dec={model_cfg['dec_layers']}L")

# ── Datasets & loaders ──────────────────────────────────────
min_len = train_cfg["min_seq_len"]
max_len = train_cfg["max_seq_len"]

train_ds = SortingDataset(train_cfg["num_train_samples"],
                          min_len=min_len, max_len=max_len, seed=42)
val_ds = SortingDataset(train_cfg["num_val_samples"],
                        min_len=min_len, max_len=max_len, seed=12345)

train_loader = DataLoader(train_ds, batch_size=train_cfg["batch_size"],
                          shuffle=True, collate_fn=collate_fn)
val_loader = DataLoader(val_ds, batch_size=train_cfg["batch_size"],
                        shuffle=False, collate_fn=collate_fn)


def infinite(loader):
    """Yield batches forever, restarting the loader each epoch."""
    while True:
        yield from loader


# ── Training setup ───────────────────────────────────────────
warmup_steps = train_cfg.get("warmup_steps", 0)
if warmup_steps > 0:
    optimizer = torch.optim.Adam(model.parameters(), lr=1.0,
                                 betas=(0.9, 0.98), eps=1e-9)
    scheduler = transformer_lr_scheduler(optimizer, model_cfg["d_model"], warmup_steps)
else:
    optimizer = torch.optim.Adam(model.parameters(), lr=train_cfg["learning_rate"])
    scheduler = None
loss_fn = nn.CrossEntropyLoss(ignore_index=PAD)

steps = train_cfg["steps"]
log_every = train_cfg.get("log_every", 100)
eval_every = train_cfg.get("eval_every", 500)


# ── Helpers ──────────────────────────────────────────────────
def extract_sequence(tokens, eos_id=EOS):
    """Strip BOS prefix and everything from the first EOS onward."""
    seq = tokens[1:]  # drop BOS
    eos_pos = (seq == eos_id).nonzero(as_tuple=True)[0]
    if len(eos_pos) > 0:
        seq = seq[:eos_pos[0]]
    return seq


@torch.no_grad()
def evaluate(model, loader, n_show=3):
    """Greedy-decode the val set; report perfect-sequence accuracy."""
    model.eval()
    correct, total, examples = 0, 0, []

    for src, tgt_input, tgt_label, src_mask, tgt_mask in loader:
        src, tgt_label = src.to(device), tgt_label.to(device)
        src_mask = src_mask.to(device)

        preds = model.generate(src, max_len=max_len + 2,
                               bos_token=BOS, eos_token=EOS,
                               src_mask=src_mask)

        for i in range(src.size(0)):
            # Ground truth: strip EOS from tgt_label
            gt = tgt_label[i]
            gt = gt[gt != PAD]
            gt = gt[gt != EOS]

            pred_seq = extract_sequence(preds[i])

            is_correct = torch.equal(pred_seq.cpu(), gt.cpu())
            correct += int(is_correct)
            total += 1

            if len(examples) < n_show:
                examples.append((src[i], gt, pred_seq, is_correct))

    acc = correct / total if total else 0.0
    print(f"  Val accuracy: {correct}/{total} = {acc:.1%}")

    for src_ex, gt, pred, ok in examples:
        s = src_ex[src_ex != PAD].tolist()
        print(f"    Input:    {s}")
        print(f"    Expected: {gt.tolist()}")
        print(f"    Got:      {pred.tolist()}  {'✓' if ok else '✗'}")

    model.train()
    return acc


# ── Training loop ────────────────────────────────────────────
print(f"\nTraining for {steps} steps  (sorting seqs of len {min_len}-{max_len})\n")

train_iter = infinite(train_loader)

for step in range(steps):
    src, tgt_input, tgt_label, src_mask, tgt_mask = next(train_iter)
    src = src.to(device)
    tgt_input = tgt_input.to(device)
    tgt_label = tgt_label.to(device)
    src_mask = src_mask.to(device)
    tgt_mask = tgt_mask.to(device)

    logits = model(src, tgt_input, src_mask=src_mask, tgt_mask=tgt_mask)
    loss = loss_fn(logits.view(-1, model_cfg["vocab_size"]), tgt_label.view(-1))

    optimizer.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    optimizer.step()
    if scheduler is not None:
        scheduler.step()

    if step % log_every == 0:
        current_lr = optimizer.param_groups[0]["lr"]
        print(f"Step {step:>5d}/{steps}  Loss: {loss.item():.4f}  LR: {current_lr:.6f}")

    if step > 0 and step % eval_every == 0:
        evaluate(model, val_loader)
        print()

# Final eval
print("\n── Final evaluation ──")
evaluate(model, val_loader, n_show=5)
print("Done.")
