"""Tests for UI branch changes — verifies HTML elements, CSS classes,
and JS functions exist and are correctly wired after passes 1-7."""

import re
from pathlib import Path

import pytest

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
INDEX_HTML = STATIC_DIR / "index.html"
APP_JS = STATIC_DIR / "app.js"
UI_CSS = STATIC_DIR / "style.ui-branch.css"


@pytest.fixture
def html():
    return INDEX_HTML.read_text(encoding="utf-8")


@pytest.fixture
def js():
    return APP_JS.read_text(encoding="utf-8")


@pytest.fixture
def css():
    return UI_CSS.read_text(encoding="utf-8")


# -----------------------------------------------------------------------
# Pass 1: Global CSS Foundation
# -----------------------------------------------------------------------

class TestPass1GlobalCSS:
    def test_font_feature_settings(self, css):
        assert 'font-feature-settings' in css
        assert '"ss01"' in css

    def test_svg_reset_scoped(self, css):
        # Should be scoped to content areas, NOT global
        assert '.doc-body svg' in css or '.markdown-body svg' in css
        # Should NOT have bare `svg { display: block }`
        lines = css.split('\n')
        for line in lines:
            stripped = line.strip()
            if stripped.startswith('svg {') and 'display: block' in stripped:
                # This is the global reset — should not exist
                assert False, "Global svg { display: block } found — should be scoped"

    def test_design_tokens_exist(self, css):
        assert '--fs-xl' in css
        assert '--sp-6' in css
        assert '--shadow-lg' in css
        assert '--c-method' in css
        assert '--c-signal' in css
        assert '--density' in css

    def test_toolbar_height_density_responsive(self, css):
        assert 'calc(' in css and '--density' in css

    def test_scrollbar_inset_trick(self, css):
        assert 'border: 2px solid var(--bg)' in css

    def test_fonts_loaded_locally(self, html):
        """Fonts should be bundled locally, not loaded from Google"""
        assert 'fonts.googleapis.com' not in html
        assert 'fonts.css' in html


# -----------------------------------------------------------------------
# Pass 2: Settings Dropdown
# -----------------------------------------------------------------------

class TestPass2SettingsDropdown:
    def test_dropdown_fixed_position(self, css):
        # Should use fixed positioning
        assert 'position: fixed' in css
        # z-index 310
        assert 'z-index: 310' in css

    def test_grid_layout_items(self, css):
        assert 'grid-template-columns: 22px 1fr auto' in css

    def test_group_label_exists(self, html):
        assert 'sm-group-label' in html
        assert 'Palettes' in html

    def test_palette_items_exist(self, html):
        assert 'Appearance' in html
        assert 'Model &amp; agent' in html or 'Model & agent' in html
        assert 'Tools &amp; permissions' in html or 'Tools & permissions' in html

    def test_about_loom_exists(self, html):
        assert 'About Loom' in html

    def test_workspace_item_exists(self, html):
        assert 'Workspace' in html


# -----------------------------------------------------------------------
# Pass 3: Appearance Palette
# -----------------------------------------------------------------------

class TestPass3AppearancePalette:
    def test_palette_element_exists(self, html):
        assert 'id="palette-appearance"' in html

    def test_palette_floating_card_position(self, css):
        # Should be floating card, not sidebar
        assert 'max-height: 70vh' in css

    def test_palette_has_all_settings(self, html):
        assert 'data-setting="palette"' in html
        assert 'data-setting="theme"' in html
        assert 'data-setting="typography"' in html
        assert 'data-setting="density"' in html
        assert 'data-setting="accent"' in html
        assert 'data-setting="canvas"' in html
        assert 'data-setting="threads"' in html

    def test_palette_has_font_size_slider(self, html):
        assert 'global-font-size' in html

    def test_palette_footer(self, html):
        assert 'Esc to dismiss' in html
        assert 'Full settings' in html

    def test_dotted_row_separators(self, css):
        assert '1px dotted' in css


# -----------------------------------------------------------------------
# Pass 4: Segmented Controls
# -----------------------------------------------------------------------

class TestPass4SegmentedControls:
    def test_equal_width_buttons(self, css):
        # .seg button should have flex: 1
        seg_section = css[css.find('.seg button'):]
        assert 'flex: 1' in seg_section[:200]

    def test_small_variant(self, css):
        assert '.seg.small' in css


# -----------------------------------------------------------------------
# Pass 5: Palette Variants
# -----------------------------------------------------------------------

class TestPass5PaletteVariants:
    def test_slate_palette_exists(self, css):
        assert 'data-palette="slate"' in css

    def test_mono_typography_exists(self, css):
        assert 'data-typography="mono"' in css

    def test_paper_font_read(self, css):
        assert 'Newsreader' in css

    def test_doc_body_uses_font_ui(self, css):
        """Card body should use --font-ui, NOT --font-read"""
        # Find the .doc-body { block (not .doc-body svg)
        match = re.search(r'\.doc-body\s*\{([^}]+)\}', css)
        assert match, ".doc-body { } rule not found"
        block = match.group(1)
        assert '--font-ui' in block
        assert '--font-read' not in block


# -----------------------------------------------------------------------
# Pass 6: Card Polish
# -----------------------------------------------------------------------

class TestPass6CardPolish:
    def test_no_duplicate_dot_pseudo(self, css):
        """Should NOT have ::before pseudo for dots (removed)"""
        # The old pattern was html[data-accent="dot"] .doc-handle::before with content: ""
        lines = css.split('\n')
        for i, line in enumerate(lines):
            if 'data-accent="dot"' in line and '.doc-handle::before' in line:
                # Check if it has content: "" (active dot pseudo)
                block = '\n'.join(lines[i:i+8])
                if 'content: ""' in block:
                    assert False, "Duplicate dot ::before pseudo still exists"

    def test_card_dot_element_styled(self, css):
        assert '.card-dot' in css

    def test_no_subtitle_in_cards(self, js):
        """Subtitle should be removed from createDocCard"""
        func = js[js.find('function createDocCard'):]
        func_end = func.find('\nfunction ')
        func = func[:func_end] if func_end > 0 else func[:3000]
        assert 'card-filename' not in func

    def test_card_body_font_14px(self, css):
        match = re.search(r'\.doc-body\s*\{([^}]+)\}', css)
        assert match, ".doc-body { } rule not found"
        assert '14px' in match.group(1)

    def test_first_child_no_margin(self, css):
        assert '.doc-body > :first-child' in css


# -----------------------------------------------------------------------
# Pass 7: Toolbar + Model Palette
# -----------------------------------------------------------------------

class TestPass7Toolbar:
    def test_theme_dropdown_removed(self, html):
        """Theme dropdown HTML should be removed — use Appearance palette instead."""
        assert 'id="theme-dropdown-wrap"' not in html

    def test_icon_buttons_28px(self, css):
        icon_btn = css[css.find('.tb-icon-btn'):]
        block = icon_btn[:icon_btn.find('}')]
        assert '28px' in block

    def test_model_palette_exists(self, html):
        assert 'id="palette-model"' in html

    def test_model_palette_has_controls(self, html):
        assert 'data-setting="model"' in html
        assert 'data-setting="reasoning"' in html
        assert 'temperature-slider' in html

    def test_search_placeholder_updated(self, html):
        assert 'Search pages, files, chats' in html


# -----------------------------------------------------------------------
# Critical Element Existence
# -----------------------------------------------------------------------

class TestCriticalElements:
    """Verify all elements that JS expects actually exist in HTML."""

    REQUIRED_IDS = [
        'settings-code-font',
        'settings-code-font-val',
        'settings-loom-root',
        'settings-save-root',
        'settings-auth-status',
        'settings-login',
        'btn-auto-layout',
        'btn-fit',
        'search-input',
        'chat-input',
        'chat-send',
        'chat-stop',
        'chat-panel',
        'sidebar',
        'infinite-canvas',
        'world',
        'edge-layer',
        'breadcrumb-bar',
        'palette-appearance',
        'palette-model',
    ]

    def test_all_required_ids_exist(self, html):
        missing = []
        for eid in self.REQUIRED_IDS:
            if f'id="{eid}"' not in html:
                missing.append(eid)
        assert not missing, f"Missing HTML elements: {missing}"


# -----------------------------------------------------------------------
# Floating Panel Parity
# -----------------------------------------------------------------------

class TestFloatingPanelParity:
    """Verify floating panels get the same features as main panel."""

    def test_floating_panel_has_context_chip(self, js):
        """createFloatingPanel should create context chip"""
        func = js[js.find('function createFloatingPanel'):]
        func_end = func.find('\nfunction ', 100)
        func = func[:func_end] if func_end > 0 else func[:5000]
        assert 'chat-context-chip' in func

    def test_floating_panel_has_pills_row(self, js):
        func = js[js.find('function createFloatingPanel'):]
        func_end = func.find('\nfunction ', 100)
        func = func[:func_end] if func_end > 0 else func[:5000]
        assert 'chat-input-pills' in func

    def test_floating_panel_has_model_pill(self, js):
        """Floating panel assistant messages should have model pill.
        The pill is added in createFloatingPanel's send handler."""
        start = js.find('function createFloatingPanel')
        end = js.find('function connectPanelChat') if 'connectPanelChat' in js else start + 15000
        region = js[start:end]
        assert 'model-pill' in region, "Model pill not found in createFloatingPanel code"


# -----------------------------------------------------------------------
# CSS Class Consistency
# -----------------------------------------------------------------------

class TestCSSClassConsistency:
    """Verify no orphaned/prototype class names leak into CSS."""

    def test_no_bare_card_class(self, css):
        """Should use .doc-card, not bare .card"""
        # Allow .card-dot, .card-foot, .card-meta etc but not bare .card {
        lines = css.split('\n')
        for line in lines:
            stripped = line.strip()
            if stripped.startswith('.card ') or stripped.startswith('.card{'):
                assert False, f"Bare .card selector found: {stripped}"

    def test_no_orphaned_tb_tabs(self, css):
        assert '.tb-tabs ' not in css, "Orphaned .tb-tabs selector (should be .tb-tab-group)"

    def test_no_orphaned_tb_chip(self, css):
        """Should not have .tb-chip rules"""
        lines = css.split('\n')
        for line in lines:
            if '.tb-chip' in line and '.tb-chip' == line.strip()[:8]:
                assert False, f"Orphaned .tb-chip selector: {line.strip()}"

    def test_uses_real_edge_selector(self, css):
        """Should use #edge-layer path, not .edges path"""
        if '.edges path' in css:
            assert False, "Prototype .edges path selector found — use #edge-layer path"
