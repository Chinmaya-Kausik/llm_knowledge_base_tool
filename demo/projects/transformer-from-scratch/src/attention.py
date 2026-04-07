import torch
import torch.nn as nn
import math


class MultiHeadAttention(nn.Module):
    """Unified multi-head attention supporting self-attention, causal (masked)
    self-attention, and cross-attention.

    Args:
        d_model:  Model / embedding dimension.
        n_heads:  Number of attention heads.
        dropout:  Dropout probability applied after softmax.
    """

    def __init__(self, d_model, n_heads, dropout=0.1):
        super().__init__()
        assert d_model % n_heads == 0, "d_model must be divisible by n_heads"
        self.n_heads = n_heads
        self.d_k = d_model // n_heads

        self.W_q = nn.Linear(d_model, d_model)
        self.W_k = nn.Linear(d_model, d_model)
        self.W_v = nn.Linear(d_model, d_model)
        self.W_o = nn.Linear(d_model, d_model)

        self.attn_dropout = nn.Dropout(dropout)

    def forward(self, q, k=None, v=None, mask=None):
        """
        Args:
            q:    Query tensor           (B, T_q, d_model)
            k:    Key tensor             (B, T_k, d_model)  — defaults to q (self-attention)
            v:    Value tensor           (B, T_k, d_model)  — defaults to k
            mask: Bool tensor broadcastable to (B, 1, T_q, T_k).
                  True = **masked / ignored** position.

        Returns:
            Output tensor (B, T_q, d_model)
        """
        if k is None:
            k = q
        if v is None:
            v = k

        B, T_q, _ = q.shape
        T_k = k.size(1)

        # Project and reshape to (B, n_heads, T, d_k)
        q = self.W_q(q).view(B, T_q, self.n_heads, self.d_k).transpose(1, 2)
        k = self.W_k(k).view(B, T_k, self.n_heads, self.d_k).transpose(1, 2)
        v = self.W_v(v).view(B, T_k, self.n_heads, self.d_k).transpose(1, 2)

        # Scaled dot-product attention
        attn = (q @ k.transpose(-2, -1)) / math.sqrt(self.d_k)  # (B, H, T_q, T_k)

        if mask is not None:
            attn = attn.masked_fill(mask, float("-inf"))

        attn = torch.softmax(attn, dim=-1)
        attn = self.attn_dropout(attn)

        out = (attn @ v).transpose(1, 2).contiguous().view(B, T_q, -1)
        return self.W_o(out)


# ── Convenience aliases ─────────────────────────────────────────


class SelfAttention(MultiHeadAttention):
    """Bidirectional self-attention (encoder-style)."""

    def forward(self, x, mask=None):
        return super().forward(q=x, mask=mask)


class CausalSelfAttention(MultiHeadAttention):
    """Self-attention with an auto-generated causal (triangular) mask so each
    position can only attend to itself and earlier positions."""

    def forward(self, x, mask=None):
        T = x.size(1)
        # Upper-triangular = True → those positions are blocked
        causal = torch.triu(torch.ones(T, T, device=x.device, dtype=torch.bool), diagonal=1)
        causal = causal.unsqueeze(0).unsqueeze(0)  # (1, 1, T, T) — broadcasts over B, H

        if mask is not None:
            causal = causal | mask  # combine with padding mask if provided

        return super().forward(q=x, mask=causal)


class CrossAttention(MultiHeadAttention):
    """Cross-attention: queries come from the decoder, keys/values from the
    encoder memory."""

    def forward(self, x, context, mask=None):
        return super().forward(q=x, k=context, v=context, mask=mask)
