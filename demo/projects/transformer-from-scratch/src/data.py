"""Synthetic sorting dataset for seq2seq training."""

import torch
from torch.utils.data import Dataset
from torch.nn.utils.rnn import pad_sequence

# Special tokens
PAD = 0
BOS = 1
EOS = 2


class SortingDataset(Dataset):
    """Each sample: random integers → same integers sorted ascending.

    Token IDs 0-3 are reserved (PAD/BOS/EOS/unused), so data values
    live in [min_val, max_val] ⊂ [4, vocab_size-1].
    """

    def __init__(self, num_samples, min_len=5, max_len=20,
                 min_val=4, max_val=999, seed=42):
        self.num_samples = num_samples
        self.min_len = min_len
        self.max_len = max_len
        self.min_val = min_val
        self.max_val = max_val
        self.seed = seed

    def __len__(self):
        return self.num_samples

    def __getitem__(self, idx):
        rng = torch.Generator().manual_seed(self.seed + idx)
        length = torch.randint(self.min_len, self.max_len + 1, (1,),
                               generator=rng).item()

        src = torch.randint(self.min_val, self.max_val + 1, (length,),
                            generator=rng)
        sorted_seq, _ = src.sort()

        # Teacher forcing: decoder input gets BOS prefix, label gets EOS suffix
        tgt_input = torch.cat([torch.tensor([BOS]), sorted_seq])
        tgt_label = torch.cat([sorted_seq, torch.tensor([EOS])])

        return src, tgt_input, tgt_label


def collate_fn(batch):
    """Pad variable-length sequences and build attention masks.

    Mask convention (matching attention.py): True = masked / ignored.
    """
    srcs, tgt_inputs, tgt_labels = zip(*batch)

    src = pad_sequence(srcs, batch_first=True, padding_value=PAD)
    tgt_input = pad_sequence(tgt_inputs, batch_first=True, padding_value=PAD)
    tgt_label = pad_sequence(tgt_labels, batch_first=True, padding_value=PAD)

    # (B, 1, 1, T) — broadcasts over heads and query positions
    src_mask = (src == PAD).unsqueeze(1).unsqueeze(2)
    tgt_mask = (tgt_input == PAD).unsqueeze(1).unsqueeze(2)

    return src, tgt_input, tgt_label, src_mask, tgt_mask
