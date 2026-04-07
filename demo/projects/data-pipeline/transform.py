"""Data transformation and cleaning."""
import re
from typing import List, Dict

def clean_text(text: str) -> str:
    """Remove HTML, normalize whitespace."""
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s+", " ", text).strip()
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
