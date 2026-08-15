# Demo font provenance

These documentation-only assets come from official Noto variable fonts. The CJKV asset is a static
Medium instance; the other four retain their variable axes. Together they exercise CJKV, Arabic,
Devanagari, Hebrew, Thai, Greek, Cyrillic, and Vietnamese through the live
`FontRegistry → HarfBuzz → glyph-ID MSDF` path. The combined payload is 125.9 KiB.

| Asset                           | Source                                                                                                                                    | Source SHA-256                                                     | Subset SHA-256                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `noto-sans-cjkv-demo.ttf`       | [Noto Sans CJK SC Variable](https://github.com/notofonts/noto-cjk/raw/main/Sans/Variable/TTF/NotoSansCJKsc-VF.ttf)                        | `990c807e79c25662a5a9ecf7f971baeb2bf2eab9a559e5ecf15cdfdb8561d21f` | `5fa2f79c0af4a16b5c1c0ae38a46bf059dd8d112a47198450ce37aeacb32582a` |
| `noto-sans-arabic-demo.ttf`     | [Noto Sans Arabic Variable](https://github.com/google/fonts/blob/main/ofl/notosansarabic/NotoSansArabic%5Bwdth%2Cwght%5D.ttf)             | `63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e` | `6649353be1ef1953082db55901458866ad151bcbd183a07a3e29b6b5b29fb1f3` |
| `noto-sans-devanagari-demo.ttf` | [Noto Sans Devanagari Variable](https://github.com/google/fonts/blob/main/ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf) | `9ce7b04f60e363d8870e5997744cf85cf69d38a4d7d129d364d92a3b14b461d7` | `fa3cdcbea5cf83079b97dff95ba4e3e980538f3b78cbeabca9869a2b9b0bf99d` |
| `noto-sans-hebrew-demo.ttf`     | [Noto Sans Hebrew Variable](https://github.com/google/fonts/blob/main/ofl/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf)             | `7ef36a2c3593758cdb622e1bdef4f84523e92fbc3ccc667438dd80ff54c2de88` | `12ddc32ebd5fc604751c10ed1e60d9e804cdd367ed1c8a62d6ac0f2218c6b55a` |
| `noto-sans-thai-demo.ttf`       | [Noto Sans Thai Variable](https://github.com/google/fonts/blob/main/ofl/notosansthai/NotoSansThai%5Bwdth%2Cwght%5D.ttf)                   | `5a1c559bb539583c8a1fd99d1c5b9491e5e14478c9cd2bd0970d5c3096cc9ef8` | `1886d9681105d3ac85e176044541e8d6e34891d33c556e8c26b00a7d44a4a40a` |

All five sources use the SIL Open Font License 1.1. The retained font name tables carry their
copyright notices; `OFL.txt` carries the complete license. The assets live under `site/public`,
outside the npm package file set.

Each subset was generated with FontTools `pyftsubset`, its exact demo string,
`--layout-features='*'`, glyph names, Unicode cmaps, `.notdef`, all name IDs and languages. The CJKV
subset was then instantiated with `fontTools.varLib.instancer` at `wght=500 --static`; this avoids
the upstream variable font's Thin `wght=100` default in rasterizers without variation-axis input.
The source files and tool cache stay outside the repository.
