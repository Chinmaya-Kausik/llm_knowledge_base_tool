---
tags:
- nlp
- machine-learning
title: Embeddings
type: concept
---

# Embeddings

Dense vector representations of discrete objects (words, tokens, images).

## Word Embeddings
- Word2Vec (CBOW, Skip-gram)
- GloVe (co-occurrence statistics)
- [[BERT]] contextual embeddings (different vector per context)

## Token Embeddings in [[Transformer Architecture]]
Input tokens → embedding lookup → add positional encoding → feed to attention layers.

## Sentence Embeddings
Pool token embeddings for sentence-level tasks. Used in retrieval, clustering, similarity.
