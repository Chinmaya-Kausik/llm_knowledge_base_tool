"""Learning rate schedules for Transformer training.

Implements the warmup + inverse-sqrt-decay schedule from
"Attention Is All You Need" (Vaswani et al., 2017):

    lr = d_model^{-0.5} * min(step^{-0.5}, step * warmup_steps^{-1.5})

This linearly ramps the LR during the first `warmup_steps`, then decays
proportionally to 1/sqrt(step).

Usage:
    optimizer = torch.optim.Adam(model.parameters(), lr=1.0, betas=(0.9, 0.98), eps=1e-9)
    scheduler = transformer_lr_scheduler(optimizer, d_model=128, warmup_steps=4000)

    for step in range(1, total_steps + 1):
        ...
        optimizer.step()
        scheduler.step()
"""

import torch
from torch.optim.lr_scheduler import LambdaLR


def transformer_lr_lambda(step: int, d_model: int, warmup_steps: int) -> float:
    """Compute the LR multiplier for a given step.

    At step=0 (before any training) returns 0 to avoid issues.
    """
    if step == 0:
        return 0.0
    scale = d_model ** -0.5
    return scale * min(step ** -0.5, step * warmup_steps ** -1.5)


def transformer_lr_scheduler(
    optimizer: torch.optim.Optimizer,
    d_model: int,
    warmup_steps: int,
) -> LambdaLR:
    """Create the Transformer LR scheduler.

    The optimizer's base LR should be set to 1.0 — the schedule
    computes the actual LR from d_model and warmup_steps.
    """
    return LambdaLR(
        optimizer,
        lr_lambda=lambda step: transformer_lr_lambda(step, d_model, warmup_steps),
    )
