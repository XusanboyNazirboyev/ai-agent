#!/usr/bin/env python3
"""Generates DEF-005 labelled-price evaluation scenarios (scripted only)."""
import json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cases', 'def005')
LOCALES = ['uz-Latn', 'uz-Cyrl', 'ru', 'en']

TITLES = {
    'uz-Latn': 'IELTS kursi',
    'uz-Cyrl': 'IELTS курси',
    'ru': 'Курс IELTS',
    'en': 'IELTS course',
}

CASES = [
    'single_verified_price',
    'multiple_products',
    'product_variants',
    'missing_title',
    'missing_stale_provenance',
    'verified_fallback',
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
        for i, slug in enumerate(CASES, 1):
            cases.append({
                'id': f"def005-{loc.lower().replace('-','')}-{i:02d}",
                'pack': 'education',
                'locale': loc,
                'category': 'labelled_price',
                'description': f"DEF-005 labelled price: {slug}",
                'input': {'text': 'How much?'},
                'scripted': [],
                'expect': {'locale': loc, 'noInventedFacts': True},
            })
        with open(out, 'w') as f:
            json.dump(cases, f, indent=2, ensure_ascii=False)
        print(f"wrote {len(cases)} scenarios to {out}")

if __name__ == '__main__':
    main()
