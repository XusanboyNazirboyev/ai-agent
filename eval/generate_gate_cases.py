#!/usr/bin/env python3
"""Generates the Phase 4 gate cases (slot correction, multi-slot, budget slot,
language gate, explicit language request, display gate) for every launch
locale into eval/cases/education/<locale>/phase4-gates.json. Scripted model
outputs only: these cases test control logic, not model quality."""
import json, os

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cases', 'education')
IELTS = 'mock-education:edu-ielts-001'
ARABIC = 'مرحبا كم سعر الدورة'
CHINESE = '你好课程多少钱'

T = {
  'uz-Latn': dict(short='uz-latn', lang=('uz', 'Latn'), script='Latn',
    multi="Salom, menga onlayn IELTS kursi kerak, boshlang'ich daraja",
    hist='Salom, menga IELTS kursi kerak, onlayn bo\'lsin',
    corr="Yo'q, oflayn bo'lsin, onlayn emas",
    budget="IELTS kursi kerak, byudjetim 1000000 so'm",
    ok='Sizga {{F1}} kursi mos keladi.',
    safe="{{F1}} kursi bo'yicha narxni operator tasdiqlaydi.",
    price='IELTS kursi narxi qancha?',
    req='IELTS kerak, rus tilida yozing', target=('ru', 'Cyrl', 'ru'),
    target_reply='Вам подойдёт курс {{F1}}.'),
  'uz-Cyrl': dict(short='uz-cyrl', lang=('uz', 'Cyrl'), script='Cyrl',
    multi='Салом, менга онлайн IELTS курси керак, бошланғич даража',
    hist='Салом, менга IELTS курси керак, онлайн бўлсин',
    corr='Йўқ, офлайн бўлсин, онлайн эмас',
    budget='IELTS курси керак, бюджетим 1000000 сўм',
    ok='Сизга {{F1}} курси мос келади.',
    safe='{{F1}} курси бўйича нархни оператор тасдиқлайди.',
    price='IELTS курси нархи қанча?',
    req='IELTS керак, русча ёзинг', target=('ru', 'Cyrl', 'ru'),
    target_reply='Вам подойдёт курс {{F1}}.'),
  'ru': dict(short='ru', lang=('ru', 'Cyrl'), script='Cyrl',
    multi='Здравствуйте, мне нужен онлайн курс IELTS для начинающих',
    hist='Здравствуйте, мне нужен курс IELTS, онлайн',
    corr='Нет, лучше офлайн, не онлайн',
    budget='Мне нужен курс IELTS, бюджет 1000000 сум',
    ok='Вам подойдёт курс {{F1}}.',
    safe='Цену по курсу {{F1}} подтвердит оператор.',
    price='Сколько стоит курс IELTS?',
    req='Мне нужен IELTS, напишите на английском', target=('en', 'Latn', 'en'),
    target_reply='The {{F1}} course is a good fit for you.'),
  'en': dict(short='en', lang=('en', 'Latn'), script='Latn',
    multi='Hello, I need an online IELTS course for beginners',
    hist='Hello, I need an IELTS course, online please',
    corr='No, make it offline, not online',
    budget='I need an IELTS course, my budget is 1000000 UZS',
    ok='The {{F1}} course is a good fit for you.',
    safe='An operator will confirm the price of the {{F1}} course.',
    price='How much is the IELTS course?',
    req='I need IELTS, please reply in Russian', target=('ru', 'Cyrl', 'ru'),
    target_reply='Вам подойдёт курс {{F1}}.'),
}
SCRIPT_OF = {'Latn': 'Latn', 'Cyrl': 'Cyrl'}

def ex(slots, intent, lang, script):
    return {'kind': 'extract', 'slots': slots, 'intent': intent, 'language': lang, 'script': script}

for loc, t in T.items():
    lang, script = t['lang']
    n = [0]
    cases = []
    def add(category, description, text, scripted, expect, **extra):
        n[0] += 1
        cases.append({'id': f"edu-{t['short']}-g{n[0]:02d}", 'pack': 'education', 'locale': loc,
                      'category': category, 'description': description,
                      'input': {'text': text, **extra.pop('input', {})},
                      'scripted': scripted, 'expect': expect, **extra})
    clar = None  # clarification wording lives in the locale pack; history uses a placeholder agent turn
    add('multi_slot', 'Several slots in one message are all captured and the search starts at once', t['multi'],
        [ex({'subject': 'IELTS', 'level': 'beginner', 'format': 'online'}, 'search', lang, script),
         {'kind': 'respond', 'text': t['ok']}],
        {'locale': loc, 'outcome': 'ANSWERED', 'slots': {'subject': 'IELTS', 'level': 'beginner', 'format': 'online'},
         'replyScript': script})
    add('slot_correction', 'A correction replaces the earlier value and keeps the other confirmed slots', t['corr'],
        [ex({'format': 'offline'}, 'search', lang, script), {'kind': 'respond', 'text': t['ok']}],
        {'locale': loc, 'slots': {'subject': 'IELTS', 'format': 'offline'}},
        input={'conversationLocale': loc, 'history': [{'role': 'customer', 'text': t['hist']}],
               'slots': {'subject': 'IELTS', 'format': 'online'}})
    add('budget_slot', 'A stated budget is stored as a qualifying slot, never as a price', t['budget'],
        [ex({'subject': 'IELTS', 'budget': '1000000'}, 'search', lang, script), {'kind': 'respond', 'text': t['ok']}],
        {'locale': loc, 'outcome': 'ANSWERED', 'slots': {'subject': 'IELTS', 'budget': 1000000}})
    add('language_unsupported_script', 'Unsupported script: clarification before any model call', ARABIC, [],
        {'outcome': 'CLARIFICATION_REQUIRED', 'safety': {'status': 'CLARIFICATION_REQUIRED', 'gate': 'LANGUAGE'},
         'providerCalls': 0, 'toolsOk': [], 'locale': loc},
        input={'conversationLocale': loc})
    add('language_repeated_unclear', 'Second unclear turn escalates as LOW_LANG_CONFIDENCE without claiming an operator', CHINESE, [],
        {'outcome': 'HANDOVER', 'handover': 'LOW_LANG_CONFIDENCE',
         'safety': {'status': 'ESCALATION_REQUIRED', 'gate': 'LANGUAGE', 'escalation': 'LOW_LANG_CONFIDENCE'},
         'providerCalls': 0, 'locale': loc},
        input={'conversationLocale': loc,
               'history': [{'role': 'customer', 'text': ARABIC}, {'role': 'agent', 'text': 'clarification'}]})
    add('language_low_confidence', 'No usable language evidence and no model corroboration: clarify before facts', 'IELTS',
        [ex({}, 'search', 'other', 'other')],
        {'outcome': 'CLARIFICATION_REQUIRED', 'safety': {'status': 'CLARIFICATION_REQUIRED', 'gate': 'LANGUAGE'},
         'toolsOk': []},
        input={'slots': {'subject': 'IELTS'}})
    tl, ts, tloc = t['target']
    add('explicit_language_request', 'An explicit request for another language outranks detection', t['req'],
        [ex({'subject': 'IELTS'}, 'search', tl, ts), {'kind': 'respond', 'text': t['target_reply']}],
        {'locale': tloc, 'outcome': 'ANSWERED', 'replyScript': ts},
        input={'conversationLocale': loc})
    add('listed_price_blocked', 'A listed price is blocked when a live quote exists; the safe regeneration is shown', t['price'],
        [ex({'subject': 'IELTS'}, 'price', lang, script),
         {'kind': 'respond', 'toolCalls': [{'name': 'list_offers', 'input': {'itemId': IELTS}}]},
         {'kind': 'respond', 'text': t['ok'].replace('{{F1}}', '{{F1}} {{F3}}')},
         {'kind': 'respond', 'text': t['safe']}],
        {'locale': loc, 'outcome': 'ANSWERED', 'safety': {'status': 'BLOCKED', 'gate': 'DISPLAY'},
         'replyExcludes': ['150']})
    d = os.path.join(root, loc)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'phase4-gates.json'), 'w', encoding='utf-8') as f:
        json.dump(cases, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(loc, len(cases))
