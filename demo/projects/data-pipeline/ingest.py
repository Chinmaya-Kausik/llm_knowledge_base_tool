"""Data ingestion from various sources."""
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
