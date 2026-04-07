"""Simple word-level tokenizer built from scratch.

Keeps with the 'from scratch' spirit of this project — no external
tokenizer libraries. Builds a vocabulary from raw text, handles
lowercasing, and maps words ↔ integer IDs.
"""

import re
import json
from pathlib import Path
from collections import Counter

# Reserved tokens — same IDs as data.py for consistency
PAD = 0
BOS = 1
EOS = 2
UNK = 3

SPECIAL_TOKENS = {
    "<pad>": PAD,
    "<bos>": BOS,
    "<eos>": EOS,
    "<unk>": UNK,
}


class WordTokenizer:
    """Whitespace + punctuation tokenizer with a fixed vocabulary.

    Usage:
        tok = WordTokenizer.from_corpus(sentences, max_vocab=8000)
        ids = tok.encode("Hello world!")       # [1, 45, 312, 2]
        text = tok.decode(ids)                  # "hello world !"
        tok.save("vocab.json")
        tok = WordTokenizer.load("vocab.json")
    """

    def __init__(self, word2id: dict[str, int]):
        self.word2id = word2id
        self.id2word = {v: k for k, v in word2id.items()}
        self.vocab_size = len(word2id)

    # ── Build from data ─────────────────────────────────────────

    @classmethod
    def from_corpus(cls, sentences: list[str], max_vocab: int = 8000,
                    min_freq: int = 2) -> "WordTokenizer":
        """Build vocabulary from a list of raw sentences."""
        counts = Counter()
        for sent in sentences:
            counts.update(cls._tokenize(sent))

        # Start with special tokens
        word2id = dict(SPECIAL_TOKENS)

        # Add most frequent words up to max_vocab
        for word, freq in counts.most_common():
            if len(word2id) >= max_vocab:
                break
            if freq < min_freq:
                break
            if word not in word2id:
                word2id[word] = len(word2id)

        return cls(word2id)

    # ── Tokenization ────────────────────────────────────────────

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        """Lowercase, split on whitespace, separate punctuation."""
        text = text.lower().strip()
        # Insert spaces around punctuation so they become separate tokens
        text = re.sub(r"([.,!?;:\"'()\-])", r" \1 ", text)
        return text.split()

    def encode(self, text: str, add_special: bool = True) -> list[int]:
        """Text → list of token IDs (with BOS/EOS by default)."""
        words = self._tokenize(text)
        ids = [self.word2id.get(w, UNK) for w in words]
        if add_special:
            ids = [BOS] + ids + [EOS]
        return ids

    def decode(self, ids: list[int], strip_special: bool = True) -> str:
        """Token IDs → text string."""
        words = []
        for i in ids:
            if strip_special and i in (PAD, BOS, EOS):
                continue
            words.append(self.id2word.get(i, "<unk>"))
        return " ".join(words)

    # ── Persistence ─────────────────────────────────────────────

    def save(self, path: str | Path):
        """Save vocabulary to JSON."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(self.word2id, f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str | Path) -> "WordTokenizer":
        """Load vocabulary from JSON."""
        with open(path) as f:
            word2id = json.load(f)
        # Ensure values are ints (JSON keys are always strings)
        word2id = {k: int(v) for k, v in word2id.items()}
        return cls(word2id)
