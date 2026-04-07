import torch
import torch.nn as nn
import math
from attention import SelfAttention, CausalSelfAttention, CrossAttention


# ── Shared Components ───────────────────────────────────────────


class PositionalEncoding(nn.Module):
    """Sinusoidal positional encoding (Vaswani et al., 'Attention Is All You Need')."""

    def __init__(self, d_model, max_len=2048, dropout=0.1):
        super().__init__()
        self.dropout = nn.Dropout(p=dropout)

        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(
            torch.arange(0, d_model, 2, dtype=torch.float) * (-math.log(10000.0) / d_model)
        )
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer("pe", pe.unsqueeze(0))  # shape: (1, max_len, d_model)

    def forward(self, x):
        x = x + self.pe[:, : x.size(1)]
        return self.dropout(x)


class FeedForward(nn.Module):
    def __init__(self, d_model, d_ff, dropout=0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(d_model, d_ff),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(d_ff, d_model),
        )

    def forward(self, x):
        return self.net(x)


# ── Encoder ─────────────────────────────────────────────────────


class EncoderBlock(nn.Module):
    def __init__(self, d_model, n_heads, d_ff, dropout=0.1):
        super().__init__()
        self.attention = SelfAttention(d_model, n_heads, dropout=dropout)
        self.norm1 = nn.LayerNorm(d_model)
        self.ff = FeedForward(d_model, d_ff, dropout)
        self.norm2 = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x, mask=None):
        x = x + self.dropout(self.attention(self.norm1(x), mask=mask))
        x = x + self.dropout(self.ff(self.norm2(x)))
        return x


# ── Decoder ─────────────────────────────────────────────────────


class DecoderBlock(nn.Module):
    """Transformer decoder block: causal self-attn → cross-attn → FFN."""

    def __init__(self, d_model, n_heads, d_ff, dropout=0.1):
        super().__init__()
        self.causal_attn = CausalSelfAttention(d_model, n_heads, dropout=dropout)
        self.norm1 = nn.LayerNorm(d_model)

        self.cross_attn = CrossAttention(d_model, n_heads, dropout=dropout)
        self.norm2 = nn.LayerNorm(d_model)

        self.ff = FeedForward(d_model, d_ff, dropout)
        self.norm3 = nn.LayerNorm(d_model)

        self.dropout = nn.Dropout(dropout)

    def forward(self, x, memory, src_mask=None, tgt_mask=None):
        """
        Args:
            x:        Decoder input          (B, T_tgt, d_model)
            memory:   Encoder output         (B, T_src, d_model)
            src_mask: Mask for cross-attn     (broadcastable to B, 1, T_tgt, T_src)
            tgt_mask: Extra mask for self-attn (e.g. padding; causal is automatic)
        """
        x = x + self.dropout(self.causal_attn(self.norm1(x), mask=tgt_mask))
        x = x + self.dropout(self.cross_attn(self.norm2(x), memory, mask=src_mask))
        x = x + self.dropout(self.ff(self.norm3(x)))
        return x


# ── Full models ─────────────────────────────────────────────────


class Transformer(nn.Module):
    """Encoder-only transformer (original model, kept for backward compat)."""

    def __init__(self, vocab_size, d_model=256, n_heads=4, n_layers=4,
                 d_ff=512, dropout=0.1, max_len=2048):
        super().__init__()
        self.token_emb = nn.Embedding(vocab_size, d_model)
        self.pos_enc = PositionalEncoding(d_model, max_len=max_len, dropout=dropout)
        self.layers = nn.ModuleList(
            [EncoderBlock(d_model, n_heads, d_ff, dropout) for _ in range(n_layers)]
        )
        self.norm = nn.LayerNorm(d_model)
        self.output_proj = nn.Linear(d_model, vocab_size, bias=False)
        self.output_proj.weight = self.token_emb.weight  # weight tying
        self._init_weights()

    def _init_weights(self):
        for p in self.parameters():
            if p.dim() > 1:
                nn.init.xavier_uniform_(p)

    def forward(self, x):
        x = self.pos_enc(self.token_emb(x))
        for layer in self.layers:
            x = layer(x)
        return self.output_proj(self.norm(x))


class EncoderDecoder(nn.Module):
    """Full encoder-decoder transformer."""

    def __init__(self, src_vocab, tgt_vocab, d_model=256, n_heads=4,
                 enc_layers=4, dec_layers=4, d_ff=512, dropout=0.1,
                 max_len=2048):
        super().__init__()
        self.d_model = d_model

        # Embeddings + positional encoding (separate for src / tgt)
        self.src_emb = nn.Embedding(src_vocab, d_model)
        self.tgt_emb = nn.Embedding(tgt_vocab, d_model)
        self.pos_enc = PositionalEncoding(d_model, max_len=max_len, dropout=dropout)

        # Encoder / decoder stacks
        self.encoder = nn.ModuleList(
            [EncoderBlock(d_model, n_heads, d_ff, dropout) for _ in range(enc_layers)]
        )
        self.decoder = nn.ModuleList(
            [DecoderBlock(d_model, n_heads, d_ff, dropout) for _ in range(dec_layers)]
        )

        self.norm = nn.LayerNorm(d_model)
        self.output_proj = nn.Linear(d_model, tgt_vocab, bias=False)
        self.output_proj.weight = self.tgt_emb.weight  # weight tying

        self._init_weights()

    def _init_weights(self):
        for p in self.parameters():
            if p.dim() > 1:
                nn.init.xavier_uniform_(p)

    def encode(self, src, src_mask=None):
        x = self.pos_enc(self.src_emb(src))
        for layer in self.encoder:
            x = layer(x, mask=src_mask)
        return x

    def decode(self, tgt, memory, src_mask=None, tgt_mask=None):
        x = self.pos_enc(self.tgt_emb(tgt))
        for layer in self.decoder:
            x = layer(x, memory, src_mask=src_mask, tgt_mask=tgt_mask)
        return self.output_proj(self.norm(x))

    def forward(self, src, tgt, src_mask=None, tgt_mask=None):
        """
        Args:
            src: Source token ids      (B, T_src)
            tgt: Target token ids      (B, T_tgt)
        Returns:
            Logits                     (B, T_tgt, tgt_vocab)
        """
        memory = self.encode(src, src_mask=src_mask)
        return self.decode(tgt, memory, src_mask=src_mask, tgt_mask=tgt_mask)

    @torch.no_grad()
    def generate(self, src, max_len, bos_token=0, eos_token=None, src_mask=None):
        """Greedy auto-regressive decoding."""
        self.eval()
        memory = self.encode(src, src_mask=src_mask)
        B = src.size(0)
        tgt = torch.full((B, 1), bos_token, dtype=torch.long, device=src.device)

        for _ in range(max_len):
            logits = self.decode(tgt, memory, src_mask=src_mask)  # (B, T, V)
            next_token = logits[:, -1, :].argmax(dim=-1, keepdim=True)  # (B, 1)
            tgt = torch.cat([tgt, next_token], dim=1)
            if eos_token is not None and (next_token == eos_token).all():
                break

        self.train()
        return tgt
