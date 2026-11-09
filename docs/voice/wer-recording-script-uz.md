# Uzbek STT WER recording script (ADR 045 slice 3)

Owner decision 2026-11-09: the owner records these lines so Scribe v2 Realtime is measured on real speech (synthetic TTS audio does not count). The lines are fictional; do not use real customer names, numbers or addresses.

## How to record

- Read each line once, at a normal phone pace, as a customer would say it. Do not over-articulate.
- Any phone voice recorder is fine; save one file per line, named `01.m4a` … `20.m4a` (any common format: m4a, ogg, wav, mp3).
- Record in a quiet room for 01–14 and with normal background noise (street, café, TV) for 15–20.
- Put the files in one folder and give its path; they stay local (gitignored), never committed, and are used only for this test.

## Lines

The reference transcript is the line exactly as written (Latin script).

| #   | Line                                                                      | What it tests       |
| --- | ------------------------------------------------------------------------- | ------------------- |
| 01  | Assalomu alaykum, ertaga soat uchga qabulga yozilmoqchiman.               | greeting, time      |
| 02  | Kurs narxi qancha turadi, oyiga to‘lasa bo‘ladimi?                        | price, ‘ (o‘)       |
| 03  | Shanba kuni ishlaysizlarmi yoki faqat hafta ichida?                       | weekdays            |
| 04  | Mening ismim Dilnoza, familiyam Rahimova.                                 | names               |
| 05  | Telefon raqamim to‘qson bir, besh yuz o‘n ikki, o‘ttiz to‘rt, ellik olti. | spoken phone number |
| 06  | Yigirma beshinchi noyabr kuni soat o‘n birda bo‘sh joy bormi?             | date and time       |
| 07  | Ikki yuz ellik ming so‘mlik paketni tanlamoqchiman.                       | amount in so‘m      |
| 08  | Chilonzor filialiga qanday borsam bo‘ladi?                                | place name          |
| 09  | Oldingi yozuvimni bekor qilib, payshanbaga ko‘chirib bering.              | reschedule          |
| 10  | Operator bilan gaplashsam bo‘ladimi?                                      | handover request    |
| 11  | Ingliz tili kursi boshlang‘ich darajadan boshlanadimi?                    | course words        |
| 12  | Bolam yetti yoshda, unga mos guruh bormi?                                 | numbers as words    |
| 13  | Kechirasiz, yaxshi eshitmadim, qaytarib ayting.                           | repair phrase       |
| 14  | Xo‘p, rahmat, unda ertaga ko‘rishamiz.                                    | closing             |
| 15  | Ertaga soat uchga qabulga yozilmoqchiman. (noise)                         | noise robustness    |
| 16  | Narxi qancha, chegirma bormi? (noise)                                     | noise, short        |
| 17  | Soat beshdan keyin qo‘ng‘iroq qila olasizmi? (noise)                      | call-back request   |
| 18  | Manzilni Telegramga yuborib qo‘ying. (noise)                              | brand word          |
| 19  | Men Samarqanddanman, onlayn o‘qisa bo‘ladimi? (noise)                     | city name           |
| 20  | Yo‘q, bu emas, boshqa kursni so‘rayapman. (noise)                         | negation            |

## How it is scored

Word error rate per line and overall, after normalising case, punctuation and the apostrophe variants (U+2018, U+2019, U+0027, U+0060, U+02BB). Numbers are compared in the form the transcript uses; a later step may add a number normaliser. Runs: no context, then `keyterms` (tenant vocabulary), then `keyterms` + `previous_text`; the difference is reported, not assumed.
