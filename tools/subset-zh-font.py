"""Rebuild fonts/zhushi-zh.woff2 from the full YRDZST Semibold font.

Run after adding Chinese text to the app, so every character has the handwritten face:
    pip install fonttools brotli
    python tools/subset-zh-font.py "path/to/YRDZST Semibold.ttf"
"""
import pathlib, sys
from fontTools import subset

root = pathlib.Path(__file__).resolve().parent.parent
text = ''.join((root / p).read_text(encoding='utf-8') for p in ('index.html', 'i18n.js', 'app.js'))
# same ranges as the @font-face unicode-range in styles.css
chars = sorted({c for c in text if 0x3000 <= ord(c) <= 0x303F or 0x4E00 <= ord(c) <= 0x9FFF or 0xFF00 <= ord(c) <= 0xFFEF})

opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = ['*']
font = subset.load_font(sys.argv[1], opts)
s = subset.Subsetter(opts)
s.populate(unicodes=[ord(c) for c in chars])
s.subset(font)
subset.save_font(font, root / 'fonts' / 'zhushi-zh.woff2', opts)
print(f'{len(chars)} characters -> fonts/zhushi-zh.woff2')
