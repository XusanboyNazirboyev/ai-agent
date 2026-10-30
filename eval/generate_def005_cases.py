#!/usr/bin/env python3
"""Generates DEF-005 labelled-price evaluation scenarios (scripted only).

Writes to eval/cases/def005/<locale>/cases.json, isolated from Phase 4 datasets.
"""
import json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cases', 'def005')
LOCALES = ['uz-Latn', 'uz-Cyrl', 'ru', 'en']

CASES = [
    ('single_verified_price', 'Single verified price with a clear product label'),
    ('multiple_products', 'Multiple products with distinct prices'),
    ('product_variants', 'Same product with multiple variants and prices'),
    ('missing_title', 'Missing product title (no invented name)'),
    ('missing_stale_provenance', 'Missing or stale price provenance (no unsupported amount)'),
    ('verified_fallback', 'Deterministic verifiedQuoteDraft fallback ({{title}}: {{price}})'),
]

def main():
    for loc in LOCALES:
        d = os.path.join(ROOT, loc)
        os.makedirs(d, exist_ok=True)
        out = os.path.join(d, 'cases.json')
        if os.path.exists(out):
            print(f"refusing to overwrite {out}", file=sys.stderr)
            sys.exit(1)
        cases = []
        for i, (slug, desc) in enumerate(CASES, 1):
            cases.append({
                'id': f"def005-{loc.lower().replace('-','')}-{i:02d}",
                'pack': 'education',
                'locale': loc,
                'category': 'labelled_price',
                'description': desc,
                'slug': slug,
                'input': {'text': 'price question'},
                'scripted': [],
                'expect': {'locale': loc},
            })
        with open(out, 'w') as f:
            json.dump(cases, f, indent=2, ensure_ascii=False)
        print(f"wrote {len(cases)} scenarios to {out}")

if __name__ == '__main__':
    main()
