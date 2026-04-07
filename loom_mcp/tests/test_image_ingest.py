"""Tests for image downloading in ingest_url."""

import tempfile
from pathlib import Path
from unittest.mock import patch

from loom_mcp.tools.ingest import _download_images


def test_download_images_rewrites_urls():
    """Test that markdown image URLs are rewritten to local paths."""
    with tempfile.TemporaryDirectory() as tmp:
        media_dir = Path(tmp) / "media"
        content = "Text before\n![diagram](https://example.com/img.png)\nText after"

        # Mock the actual download
        with patch("loom_mcp.tools.ingest.urllib.request.urlretrieve") as mock_dl:
            # Make it create the file
            def fake_download(url, path):
                Path(path).write_bytes(b"fake image")
            mock_dl.side_effect = fake_download

            result = _download_images(content, "https://example.com/page", media_dir)

        assert "raw/media/" in result
        assert "example.com" not in result
        assert "Text before" in result
        assert "Text after" in result


def test_download_images_relative_urls():
    """Test that relative image URLs are resolved against source URL."""
    with tempfile.TemporaryDirectory() as tmp:
        media_dir = Path(tmp) / "media"
        content = "![pic](images/photo.jpg)"

        with patch("loom_mcp.tools.ingest.urllib.request.urlretrieve") as mock_dl:
            def fake_download(url, path):
                # Verify the URL was resolved
                assert url.startswith("https://example.com/")
                Path(path).write_bytes(b"fake")
            mock_dl.side_effect = fake_download

            result = _download_images(content, "https://example.com/page", media_dir)

        assert "raw/media/" in result


def test_download_images_failure_preserves_original():
    """Test that failed downloads preserve the original URL."""
    with tempfile.TemporaryDirectory() as tmp:
        media_dir = Path(tmp) / "media"
        content = "![pic](https://broken.example.com/img.png)"

        with patch("loom_mcp.tools.ingest.urllib.request.urlretrieve", side_effect=Exception("Network error")):
            result = _download_images(content, "https://example.com", media_dir)

        # Original URL preserved on failure
        assert "broken.example.com" in result


def test_download_images_no_images():
    """Test content with no images passes through unchanged."""
    with tempfile.TemporaryDirectory() as tmp:
        media_dir = Path(tmp) / "media"
        content = "Just plain text\n\nNo images here."
        result = _download_images(content, "https://example.com", media_dir)
        assert result == content


def test_download_images_deterministic_filenames():
    """Same URL should produce same filename (content-addressed)."""
    with tempfile.TemporaryDirectory() as tmp:
        media_dir = Path(tmp) / "media"
        content = "![a](https://example.com/same.png)\n![b](https://example.com/same.png)"

        with patch("loom_mcp.tools.ingest.urllib.request.urlretrieve") as mock_dl:
            def fake_download(url, path):
                Path(path).write_bytes(b"fake")
            mock_dl.side_effect = fake_download

            result = _download_images(content, "https://example.com", media_dir)

        # Both should reference the same local file
        import re
        paths = re.findall(r"raw/media/\S+", result)
        assert len(paths) == 2
        assert paths[0] == paths[1]
        # Should only download once (second time file exists)
        assert mock_dl.call_count == 1
