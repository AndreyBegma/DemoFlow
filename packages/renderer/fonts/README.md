# Fonts

The FFmpeg compositor draws text with **Inter**, bundled here. The files are
read at render time from this directory; nothing is downloaded at install or
render time.

| File | Weight | Used for |
|---|---|---|
| `Inter-Regular.ttf` | 400 | caption, end card |
| `Inter-SemiBold.ttf` | 600 | the `FAILED` watermark |

## Licence

SIL Open Font License 1.1 — see `OFL.txt` (the release's `LICENSE.txt`,
unchanged). Copyright (c) 2016 The Inter Project Authors. The files here are a
Modified Version (a subset) under the same licence; the font name is unchanged,
as Inter declares no Reserved Font Name.

## Provenance

- Release: Inter **4.1**, https://github.com/rsms/inter/releases/tag/v4.1
- Archive: https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
  (sha256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`)
- Sources inside it: `extras/ttf/Inter-Regular.ttf`
  (sha256 `40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82`)
  and `extras/ttf/Inter-SemiBold.ttf`
  (sha256 `78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3`)

## The subset

Characters kept:

| Range | Block |
|---|---|
| U+0020–007E | Basic Latin |
| U+00A0–00FF | Latin-1 Supplement |
| U+0400–04FF | Cyrillic |
| U+2010–2027, U+2030–203A | General Punctuation: dashes, quotes, ellipsis, per mille, guillemets |
| U+20AC, U+20BD, U+2116, U+2122 | € ₽ № ™ |

Spec 25's ranges omitted the em dash its own acceptance caption uses, hence
the punctuation. Any other character is drawn as `?`.

Only the `kern` feature is kept, unhinted. Inter wraps its kerning in GPOS
extension lookups (type 9), which opentype.js does not read, so the subset
unwraps them into plain pair-adjustment lookups (type 2); the kerning values
are unchanged.

Made with fonttools 4.60.1 (Python 3.14). Save this as `subset.py` and run
`python subset.py <output directory>` from the directory the archive was
unzipped into:

```python
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

UNICODES = "U+0020-007E,U+00A0-00FF,U+0400-04FF,U+2010-2027,U+2030-203A,U+20AC,U+20BD,U+2116,U+2122"

for weight in ("Regular", "SemiBold"):
    font = TTFont(f"extras/ttf/Inter-{weight}.ttf", recalcTimestamp=False)
    options = subset.Options()
    options.layout_features = ["kern"]
    options.hinting = False
    options.desubroutinize = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)
    # opentype.js reads kerning only from plain pair lookups (type 2), not
    # from extension lookups (type 9) wrapping them, as Inter ships them.
    for lookup in font["GPOS"].table.LookupList.Lookup:
        if lookup.LookupType == 9:
            lookup.LookupType = lookup.SubTable[0].ExtensionLookupType
            lookup.SubTable = [table.ExtSubTable for table in lookup.SubTable]
    font.save(f"{sys.argv[1]}/Inter-{weight}.ttf")
```

The output is byte-for-byte reproducible:

- `Inter-Regular.ttf` — 52 232 bytes, sha256 `c73ca2e1e1e124e2051092718159b28b9f170e8228d3d4e982d8862939c8dd57`
- `Inter-SemiBold.ttf` — 53 100 bytes, sha256 `13accca57679c30eb1054ecffda5d54a120f5f6b3e8c7adaeedb7b56213cab16`
