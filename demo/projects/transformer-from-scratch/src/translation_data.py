"""Real translation dataset: English → German using Tatoeba sentence pairs.

Downloads tab-separated EN-DE pairs from manythings.org (Tatoeba project),
builds word-level vocabularies, and provides a PyTorch Dataset that plugs
directly into the existing EncoderDecoder model and collate_fn.
"""

import io
import os
import zipfile
import urllib.request
from pathlib import Path

import torch
from torch.utils.data import Dataset
from torch.nn.utils.rnn import pad_sequence

from tokenizer import WordTokenizer, PAD, BOS, EOS

# ── Download & parse ────────────────────────────────────────────

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
URL = "https://www.manythings.org/anki/deu-eng.zip"


def download_pairs(max_pairs: int | None = None,
                   max_len: int = 30) -> tuple[list[str], list[str]]:
    """Download EN-DE pairs and return (english_sents, german_sents).

    Filters to sentences with at most `max_len` words (keeps training fast).
    """
    zip_path = DATA_DIR / "deu-eng.zip"
    txt_path = DATA_DIR / "deu.txt"

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if not txt_path.exists():
        if not zip_path.exists():
            print(f"Downloading {URL} ...")
            urllib.request.urlretrieve(URL, zip_path)
            print(f"  Saved to {zip_path}")
        with zipfile.ZipFile(zip_path, "r") as zf:
            # The zip contains 'deu.txt' (sometimes '_about.txt' too)
            for name in zf.namelist():
                if name.endswith(".txt") and "about" not in name.lower():
                    zf.extract(name, DATA_DIR)
                    break

    en_sents, de_sents = [], []
    with open(txt_path, encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) < 2:
                continue
            en, de = parts[0], parts[1]
            # Length filter (word count)
            if len(en.split()) > max_len or len(de.split()) > max_len:
                continue
            en_sents.append(en)
            de_sents.append(de)
            if max_pairs and len(en_sents) >= max_pairs:
                break

    print(f"Loaded {len(en_sents):,} sentence pairs (max_len={max_len} words)")
    return en_sents, de_sents


# ── Dataset ─────────────────────────────────────────────────────


class TranslationDataset(Dataset):
    """PyTorch dataset for EN→DE translation.

    Each item returns (src_ids, tgt_input, tgt_label) — same contract
    as the sorting dataset, so it works with the existing collate_fn.
    """

    def __init__(self, src_sents: list[str], tgt_sents: list[str],
                 src_tok: WordTokenizer, tgt_tok: WordTokenizer,
                 max_len: int = 64):
        self.src_tok = src_tok
        self.tgt_tok = tgt_tok
        self.max_len = max_len

        # Pre-encode everything for speed
        self.pairs = []
        for s, t in zip(src_sents, tgt_sents):
            src_ids = src_tok.encode(s, add_special=False)  # no BOS/EOS on source
            tgt_ids = tgt_tok.encode(t, add_special=False)  # raw word ids

            # Skip if either side is too long after tokenization
            if len(src_ids) > max_len or len(tgt_ids) > max_len:
                continue

            self.pairs.append((
                torch.tensor(src_ids, dtype=torch.long),
                torch.tensor(tgt_ids, dtype=torch.long),
            ))

        print(f"  TranslationDataset: {len(self.pairs):,} pairs "
              f"(filtered to ≤{max_len} tokens)")

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, idx):
        src, tgt = self.pairs[idx]
        # Teacher forcing: decoder sees BOS + tgt, label is tgt + EOS
        tgt_input = torch.cat([torch.tensor([BOS]), tgt])
        tgt_label = torch.cat([tgt, torch.tensor([EOS])])
        return src, tgt_input, tgt_label


def collate_fn(batch):
    """Pad variable-length sequences and build attention masks.

    Same interface as data.collate_fn — drop-in replacement.
    Mask convention: True = masked / ignored.
    """
    srcs, tgt_inputs, tgt_labels = zip(*batch)

    src = pad_sequence(srcs, batch_first=True, padding_value=PAD)
    tgt_input = pad_sequence(tgt_inputs, batch_first=True, padding_value=PAD)
    tgt_label = pad_sequence(tgt_labels, batch_first=True, padding_value=PAD)

    # (B, 1, 1, T) — broadcasts over heads and query positions
    src_mask = (src == PAD).unsqueeze(1).unsqueeze(2)
    tgt_mask = (tgt_input == PAD).unsqueeze(1).unsqueeze(2)

    return src, tgt_input, tgt_label, src_mask, tgt_mask


# ── Convenience: prepare everything ────────────────────────────


def prepare_data(max_pairs: int | None = None,
                 max_len_words: int = 25,
                 max_len_tokens: int = 40,
                 src_vocab_size: int = 8000,
                 tgt_vocab_size: int = 8000,
                 val_split: float = 0.05,
                 vocab_dir: Path | None = None,
                 ) -> tuple[TranslationDataset, TranslationDataset,
                            WordTokenizer, WordTokenizer]:
    """One-call setup: download, tokenize, split, return datasets + tokenizers."""

    if vocab_dir is None:
        vocab_dir = DATA_DIR

    en_sents, de_sents = download_pairs(max_pairs=max_pairs,
                                         max_len=max_len_words)

    # Build or load tokenizers
    src_vocab_path = vocab_dir / "en_vocab.json"
    tgt_vocab_path = vocab_dir / "de_vocab.json"

    if src_vocab_path.exists() and tgt_vocab_path.exists():
        print("Loading cached vocabularies...")
        src_tok = WordTokenizer.load(src_vocab_path)
        tgt_tok = WordTokenizer.load(tgt_vocab_path)
    else:
        print("Building vocabularies...")
        src_tok = WordTokenizer.from_corpus(en_sents, max_vocab=src_vocab_size,
                                             min_freq=2)
        tgt_tok = WordTokenizer.from_corpus(de_sents, max_vocab=tgt_vocab_size,
                                             min_freq=2)
        src_tok.save(src_vocab_path)
        tgt_tok.save(tgt_vocab_path)

    print(f"  EN vocab: {src_tok.vocab_size:,} tokens")
    print(f"  DE vocab: {tgt_tok.vocab_size:,} tokens")

    # Train/val split
    n_val = int(len(en_sents) * val_split)
    n_train = len(en_sents) - n_val

    train_ds = TranslationDataset(
        en_sents[:n_train], de_sents[:n_train],
        src_tok, tgt_tok, max_len=max_len_tokens,
    )
    val_ds = TranslationDataset(
        en_sents[n_train:], de_sents[n_train:],
        src_tok, tgt_tok, max_len=max_len_tokens,
    )

    return train_ds, val_ds, src_tok, tgt_tok
