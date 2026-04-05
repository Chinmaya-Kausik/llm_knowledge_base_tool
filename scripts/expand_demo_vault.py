"""Expand the demo vault with a wide variety of content for stress testing."""

from pathlib import Path
from vault_mcp.lib.frontmatter import write_frontmatter
from vault_mcp.tools.compile import update_master_index, append_log
from vault_mcp.web import bootstrap_vault

demo = Path.home() / "Documents" / "vault-demo"
bootstrap_vault(demo)


def w(rel, title, tags, content, page_type="concept"):
    path = demo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    write_frontmatter(path, {"title": title, "type": page_type, "tags": tags}, content)


def wf(rel, content):
    """Write a plain file (no frontmatter)."""
    path = demo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


# ============================================================
# MORE WIKI CONCEPTS (diverse topics)
# ============================================================

w("wiki/concepts/gradient-descent/README.md", "Gradient Descent", ["optimization", "machine-learning"],
"""# Gradient Descent

Iterative optimization algorithm. Updates parameters in the direction of steepest decrease of the loss function.

## Variants
- **SGD** — stochastic, one sample at a time
- **Mini-batch** — small batches, best of both worlds
- **Adam** — adaptive learning rates per parameter, most popular

## Learning Rate
Too high → diverge. Too low → stuck. Learning rate schedulers help:
- Cosine annealing
- Warmup + decay
- [[Reinforcement Learning]] uses different optimization (policy gradient)

## Connection to [[Transformer Architecture]]
Transformers are trained with Adam optimizer + warmup schedule.
""")

w("wiki/concepts/backpropagation/README.md", "Backpropagation", ["machine-learning", "optimization"],
"""# Backpropagation

Chain rule applied to compute gradients through a computation graph.

## How it works
1. Forward pass: compute output
2. Compute loss
3. Backward pass: compute gradients via chain rule
4. Update weights via [[Gradient Descent]]

## Vanishing/Exploding Gradients
Deep networks suffer from gradients shrinking/growing exponentially.
Solutions: residual connections ([[Transformer Architecture]]), layer norm, careful initialization.
""")

w("wiki/concepts/embeddings/README.md", "Embeddings", ["nlp", "machine-learning"],
"""# Embeddings

Dense vector representations of discrete objects (words, tokens, images).

## Word Embeddings
- Word2Vec (CBOW, Skip-gram)
- GloVe (co-occurrence statistics)
- [[BERT]] contextual embeddings (different vector per context)

## Token Embeddings in [[Transformer Architecture]]
Input tokens → embedding lookup → add positional encoding → feed to attention layers.

## Sentence Embeddings
Pool token embeddings for sentence-level tasks. Used in retrieval, clustering, similarity.
""")

w("wiki/concepts/loss-functions/README.md", "Loss Functions", ["machine-learning", "optimization"],
"""# Loss Functions

Quantify how wrong the model's predictions are.

## Common Loss Functions
- **Cross-Entropy** — classification (used in [[BERT]], [[GPT]])
- **MSE** — regression
- **Contrastive Loss** — representation learning
- **KL Divergence** — distribution matching (used in RLHF)

## Connection to Training
Loss is what [[Gradient Descent]] minimizes via [[Backpropagation]].
""")

w("wiki/concepts/tokenization/README.md", "Tokenization", ["nlp", "machine-learning"],
"""# Tokenization

Breaking text into tokens that the model processes.

## Methods
- **BPE** (Byte Pair Encoding) — used by [[GPT]]
- **WordPiece** — used by [[BERT]]
- **SentencePiece** — language-agnostic
- **Byte-level** — handles any Unicode

## Vocabulary Size
Typical: 30K-100K tokens. Tradeoff: larger vocab = shorter sequences but bigger embedding table.

## Impact on [[Attention Mechanisms]]
Sequence length after tokenization determines the O(n²) cost of [[Self-Attention]].
""")

w("wiki/concepts/fine-tuning/README.md", "Fine-tuning", ["machine-learning", "nlp"],
"""# Fine-tuning

Adapting a pre-trained model to a specific task.

## Methods
- **Full fine-tuning** — update all parameters
- **LoRA** — low-rank adaptation, only train small matrices
- **Prompt tuning** — learn soft prompt vectors
- **RLHF** — [[Reinforcement Learning]] from Human Feedback (used for [[GPT]]/Claude alignment)

## Pre-trained Models
Start from [[BERT]] or [[GPT]], fine-tune on your data.
Much less data needed than training from scratch.
""")

w("wiki/concepts/regularization/README.md", "Regularization", ["machine-learning", "optimization"],
"""# Regularization

Techniques to prevent overfitting.

## Methods
- **Dropout** — randomly zero activations during training
- **Weight decay** — L2 penalty on parameters
- **Data augmentation** — more varied training data
- **Early stopping** — stop before overfitting

## In Transformers
[[Transformer Architecture]] uses dropout in attention and feed-forward layers.
[[BERT]] also uses masking as implicit regularization.
""")

# ============================================================
# WIKI INDEXES
# ============================================================

w("wiki/indexes/machine-learning/README.md", "Machine Learning Index", ["index"], """# Machine Learning Index

Overview of all ML-related pages in the vault.

## Core Concepts
- [[Gradient Descent]] — optimization
- [[Backpropagation]] — computing gradients
- [[Loss Functions]] — what we optimize
- [[Regularization]] — preventing overfitting
- [[Embeddings]] — vector representations
- [[Fine-tuning]] — adapting pre-trained models

## Architectures
- [[Transformer Architecture]] — dominant sequence model
- [[Attention Mechanisms]] → [[Self-Attention]] → [[Multi-Head Attention]]

## Models
- [[BERT]] — bidirectional encoder
- [[GPT]] — autoregressive decoder

## Training
- [[Reinforcement Learning]] — RLHF for alignment
- [[Tokenization]] — text preprocessing
""", page_type="index")

# ============================================================
# MORE WIKI ANSWERS
# ============================================================

w("wiki/answers/why-transformers-won.md", "Why Did Transformers Win?", ["transformers", "architecture"],
"""# Why Did Transformers Win?

**Q:** Why did transformers replace RNNs and LSTMs?

1. **Parallelization**: [[Self-Attention]] processes all positions simultaneously. RNNs process sequentially.
2. **Long-range dependencies**: Attention connects any two positions directly. RNNs struggle beyond ~100 tokens.
3. **Scaling**: [[Transformer Architecture]] scales predictably with compute (scaling laws).
4. **Transfer learning**: Pre-trained transformers ([[BERT]], [[GPT]]) transfer well to downstream tasks.
5. **Hardware fit**: Matrix multiplications are GPU-friendly. Attention is mostly matmul.

The key insight from "[[Attention Is All You Need]]" was that recurrence was unnecessary.
""", page_type="answer")

w("wiki/answers/lora-vs-full-finetuning.md", "LoRA vs Full Fine-tuning", ["fine-tuning"],
"""# LoRA vs Full Fine-tuning

**Q:** When should I use LoRA vs full fine-tuning?

## LoRA
- Trains ~0.1% of parameters (low-rank matrices)
- Much faster, less GPU memory
- Good for adapting to similar domains
- Can merge multiple LoRA adapters

## Full Fine-tuning
- Trains all parameters
- Better performance ceiling
- More data needed
- Risk of catastrophic forgetting

**Rule of thumb**: Start with LoRA. Only use full fine-tuning if LoRA performance plateaus and you have enough data.

Related: [[Fine-tuning]], [[Gradient Descent]]
""", page_type="answer")

# ============================================================
# PROJECT 3: Data Pipeline
# ============================================================

w("projects/data-pipeline/README.md", "Data Pipeline", ["code", "data", "python"],
"""# Data Pipeline

ETL pipeline for processing research datasets.

## Architecture
- `ingest.py` — fetch data from APIs
- `transform.py` — clean, normalize, tokenize
- `export.py` — save to parquet format
- `config.yaml` — pipeline configuration

## Status
Working on ingestion. Next: add [[Tokenization]] stage.

## Uses
- [[Embeddings]] for vector representations
- [[Tokenization]] for text processing
""", page_type="project")

wf("projects/data-pipeline/ingest.py", '''"""Data ingestion from various sources."""
import requests
import json
from pathlib import Path

def fetch_arxiv(query, max_results=10):
    """Fetch papers from arXiv API."""
    url = f"http://export.arxiv.org/api/query?search_query={query}&max_results={max_results}"
    response = requests.get(url)
    return response.text

def fetch_huggingface_dataset(name, split="train"):
    """Load a HuggingFace dataset."""
    from datasets import load_dataset
    return load_dataset(name, split=split)

def save_raw(data, path):
    """Save raw data to JSON."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)

if __name__ == "__main__":
    papers = fetch_arxiv("transformer attention", max_results=5)
    save_raw(papers, "data/raw/arxiv_papers.json")
    print("Fetched papers")
''')

wf("projects/data-pipeline/transform.py", '''"""Data transformation and cleaning."""
import re
from typing import List, Dict

def clean_text(text: str) -> str:
    """Remove HTML, normalize whitespace."""
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\\s+", " ", text).strip()
    return text

def tokenize_simple(text: str) -> List[str]:
    """Simple whitespace tokenizer."""
    return text.lower().split()

def extract_entities(text: str) -> List[Dict]:
    """Extract named entities (placeholder)."""
    # TODO: Use spaCy or similar
    return [{"text": word, "type": "UNKNOWN"} for word in text.split() if word[0].isupper()]

def transform_paper(raw: dict) -> dict:
    """Transform a raw paper record."""
    return {
        "title": clean_text(raw.get("title", "")),
        "abstract": clean_text(raw.get("abstract", "")),
        "tokens": tokenize_simple(raw.get("abstract", "")),
        "entities": extract_entities(raw.get("abstract", "")),
    }
''')

wf("projects/data-pipeline/export.py", '''"""Export processed data to various formats."""
import json
import csv
from pathlib import Path

def to_jsonl(records, path):
    """Export to JSON Lines format."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for record in records:
            f.write(json.dumps(record) + "\\n")

def to_csv(records, path, fields=None):
    """Export to CSV."""
    if not records:
        return
    fields = fields or list(records[0].keys())
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(records)
''')

wf("projects/data-pipeline/config.yaml", """pipeline:
  name: research-data-pipeline
  version: 0.1.0

sources:
  - type: arxiv
    query: "transformer attention mechanism"
    max_results: 50
  - type: huggingface
    dataset: "wikitext"
    split: "train[:1000]"

transform:
  clean_html: true
  lowercase: true
  tokenize: true
  extract_entities: false

export:
  format: jsonl
  output_dir: "data/processed/"
""")

# ============================================================
# PROJECT 4: Personal Notes / Journal
# ============================================================

w("projects/research-journal/README.md", "Research Journal", ["journal", "notes"],
"""# Research Journal

Personal notes and observations from research.

## Entries
- 2026-04-01: Started reading about [[Attention Mechanisms]]
- 2026-04-02: Implemented basic [[Self-Attention]] in PyTorch
- 2026-04-03: Comparison of [[BERT]] vs [[GPT]] for my use case
- 2026-04-04: Built the Vault tool, compiled this wiki
- 2026-04-05: Stress testing the vault with diverse content

## Key Insights
- [[Tokenization]] choice matters more than I thought
- [[Fine-tuning]] with LoRA is surprisingly effective
- Cross-project knowledge sharing is the real value of this vault
""", page_type="project")

wf("projects/research-journal/2026-04-01.md", """---
title: "April 1 — Attention Deep Dive"
date: 2026-04-01
tags: [attention, reading]
---

# April 1 — Attention Deep Dive

Read the original "Attention Is All You Need" paper. Key takeaways:
- The innovation was removing recurrence entirely, not attention itself
- Multi-head attention is basically ensemble learning for attention
- Positional encoding via sinusoids is elegant but learned embeddings work too

Questions to follow up:
- How does sparse attention compare? (BigBird, Longformer)
- What's the actual runtime difference between O(n²) and O(n√n)?
""")

wf("projects/research-journal/2026-04-03.md", """---
title: "April 3 — BERT vs GPT"
date: 2026-04-03
tags: [bert, gpt, comparison]
---

# April 3 — BERT vs GPT Comparison

Tested both for my classification task. Results:
- BERT-base: 94.2% accuracy, 50ms inference
- GPT-2 (zero-shot): 78.1% accuracy, 120ms inference
- GPT-2 (fine-tuned): 93.8% accuracy, 120ms inference

BERT wins for classification. GPT wins for generation.
For my use case (document classification), BERT is the clear choice.

Related: [[BERT]], [[GPT]], [[Fine-tuning]]
""")

# ============================================================
# MORE RAW SOURCES
# ============================================================

w("raw/articles/gpt3-paper.md", "Language Models are Few-Shot Learners", ["gpt", "scaling"],
"""# Language Models are Few-Shot Learners (Brown et al., 2020)

The [[GPT]]-3 paper. Key findings:

## Scale
175B parameters. Trained on 300B tokens.
Shows that scale alone produces emergent capabilities.

## Few-shot Learning
GPT-3 can perform tasks with just a few examples in the prompt.
No gradient updates needed — just prompt engineering.

## Implications
- Prompted the "foundation model" paradigm
- Led to ChatGPT and Claude
- Showed that [[Fine-tuning]] might not always be necessary at scale
""", page_type="summary")

w("raw/articles/lora-paper.md", "LoRA: Low-Rank Adaptation", ["fine-tuning", "efficiency"],
"""# LoRA: Low-Rank Adaptation of Large Language Models

Efficient [[Fine-tuning]] method.

## Key Idea
Instead of updating all weights W, decompose the update as W + BA where B and A are low-rank matrices.
Only train B and A — much fewer parameters.

## Results
- 10,000x fewer trainable parameters than full fine-tuning
- Comparable performance on most tasks
- Can merge into base model at inference (no latency cost)

## Impact
Made fine-tuning accessible on consumer GPUs.
Led to explosion of community-fine-tuned models.
""", page_type="summary")

w("raw/articles/flash-attention.md", "FlashAttention", ["attention", "efficiency"],
"""# FlashAttention: Fast and Memory-Efficient Attention

Optimizes [[Self-Attention]] at the hardware level.

## Problem
Standard attention materializes the n×n attention matrix — O(n²) memory.

## Solution
Tile the computation to fit in GPU SRAM. Never materialize the full matrix.
IO-aware algorithm that minimizes memory reads/writes.

## Results
- 2-4x faster than standard PyTorch attention
- Enables longer sequences (up to 64K tokens)
- Used in all modern [[Transformer Architecture]] implementations

## Connection to Vault
The [[Research Paper Draft]] project builds on FlashAttention ideas for efficient attention.
""", page_type="summary")

# ============================================================
# DATA FILES
# ============================================================

wf("projects/data-pipeline/data/sample.csv", """id,title,category,score
1,Attention Is All You Need,transformers,10
2,BERT Pre-training,language-models,9
3,GPT-3 Few-Shot Learning,language-models,9
4,FlashAttention,efficiency,8
5,LoRA Fine-tuning,fine-tuning,8
6,Scaling Laws,theory,7
7,BigBird Sparse Attention,attention,7
8,Gradient Checkpointing,efficiency,6
""")

wf("projects/data-pipeline/data/sample.json", """{
  "papers": [
    {"title": "Attention Is All You Need", "year": 2017, "citations": 90000},
    {"title": "BERT", "year": 2019, "citations": 65000},
    {"title": "GPT-3", "year": 2020, "citations": 25000},
    {"title": "LoRA", "year": 2021, "citations": 8000},
    {"title": "FlashAttention", "year": 2022, "citations": 5000}
  ]
}
""")

# ============================================================
# MORE CHAT TRANSCRIPTS
# ============================================================

wf("raw/chats/2026-04-03_research.md", """# Chat — Research Planning

## User
What papers should I read to understand efficient attention?

## Assistant
Start with these in order:
1. "Attention Is All You Need" — the baseline
2. "Longformer" — sliding window attention
3. "BigBird" — sparse attention with global tokens
4. "FlashAttention" — hardware-level optimization
5. "Linear Attention" — approximate softmax

## User
Which is most practical for implementation?

## Assistant
FlashAttention. It's a drop-in replacement for standard attention with no quality loss.
The others change the attention pattern which affects model behavior.
""")

wf("raw/chats/2026-04-04_coding.md", """# Chat — Coding Session

## User
How should I structure my transformer implementation?

## Assistant
Separate concerns:
1. `attention.py` — self-attention and multi-head attention
2. `model.py` — transformer block (attention + ffn + norm)
3. `train.py` — training loop
4. `data.py` — dataset and dataloader

This matches your current project structure in `projects/transformer-from-scratch/`.

## User
Should I use einops?

## Assistant
For readability, yes. `einops.rearrange` makes tensor reshaping much clearer than manual view/transpose chains. But start without it to understand the raw shapes first.
""")

# ============================================================
# EMPTY FOLDERS (for structure testing)
# ============================================================

(demo / "projects" / "future-project" / "src").mkdir(parents=True, exist_ok=True)
w("projects/future-project/README.md", "Future Project", ["placeholder"],
"""# Future Project

Placeholder for a future project. Nothing here yet.
""", page_type="project")

# ============================================================
# UPDATE INDEX + LOG
# ============================================================

update_master_index(demo)
append_log(demo, "expand", "Expanded demo vault: +7 concepts, +1 index, +2 answers, +2 projects, +3 papers, +2 chats, data files")

# Count everything
files = sum(1 for _ in demo.rglob("*") if _.is_file())
folders = sum(1 for _ in demo.rglob("*") if _.is_dir())
print(f"Demo vault expanded: {files} files, {folders} folders")
