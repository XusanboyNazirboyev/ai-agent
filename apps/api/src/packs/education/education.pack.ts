import { DomainPackSchema, type DomainPack } from '@agentcore/shared';

/**
 * Education Domain Pack (first vertical, AGENTS.md §5.1). Pure configuration:
 * slots, per-locale questions, enabled tools and prompt fragments. Course
 * data always comes from the tenant's connector; nothing here is a real
 * course, schedule or price.
 */
export const EDUCATION_PACK: DomainPack = DomainPackSchema.parse({
  key: 'education',
  version: '1',
  catalogItemType: 'course',
  locales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
  maxOptionsShown: 3,
  tools: [
    'search_catalog',
    'get_item_details',
    'list_offers',
    'check_availability',
    'get_quote',
  ],
  prompt: {
    businessRole:
      'You are a course consultant for an education center. You help prospective students find a suitable course or group and understand schedules, availability and prices.',
    rules: [
      'Never promise exam scores, certificates, admission or other learning outcomes.',
      'Do not give information about existing students (grades, attendance, payments); those questions go to an operator.',
      'Prefer showing matching courses first, then ask about format or schedule only if it changes which option fits.',
    ],
  },
  slots: [
    {
      key: 'subject',
      type: 'text',
      description:
        'What the student wants to learn, as the course or subject name (e.g. "IELTS", "English", "Mathematics"). Translate a described subject to its common English name ("ingliz tili" -> "English").',
      maxLength: 60,
      requiredFor: ['search', 'quote'],
      searchFilter: { kind: 'title' },
      questions: {
        'uz-Latn': "Qaysi fan yoki kurs bo'yicha o'qimoqchisiz?",
        'uz-Cyrl': 'Қайси фан ёки курс бўйича ўқимоқчисиз?',
        ru: 'Какой предмет или курс вас интересует?',
        en: 'Which subject or course are you interested in?',
      },
    },
    {
      key: 'format',
      type: 'enum',
      description:
        'Lesson format: online or in person (offline) at the center.',
      options: [
        {
          value: 'online',
          synonyms: [
            'onlayn',
            'online',
            'masofaviy',
            'internet orqali',
            'онлайн',
            'дистанционно',
            'удаленно',
          ],
        },
        {
          value: 'offline',
          synonyms: [
            'oflayn',
            'offline',
            'markazda',
            'jonli',
            'офлайн',
            'очно',
            'в центре',
            'in person',
          ],
        },
      ],
      requiredFor: ['quote'],
      searchFilter: { kind: 'attribute', attribute: 'format' },
      questions: {
        'uz-Latn':
          "Darslarni onlayn yoki markazda (oflayn) o'qishni xohlaysizmi?",
        'uz-Cyrl': 'Дарсларни онлайн ёки марказда (офлайн) ўқишни хоҳлайсизми?',
        ru: 'Вам удобнее заниматься онлайн или очно в центре?',
        en: 'Would you prefer online lessons or in person at the center?',
      },
    },
    {
      key: 'level',
      type: 'enum',
      description: 'Current level of the student in the subject.',
      options: [
        {
          value: 'beginner',
          synonyms: [
            "boshlang'ich",
            'noldan',
            'начальный',
            'с нуля',
            'beginner',
            'a1',
          ],
        },
        {
          value: 'intermediate',
          synonyms: ["o'rta", 'средний', 'intermediate', 'b1', 'b2'],
        },
        {
          value: 'advanced',
          synonyms: ['yuqori', 'продвинутый', 'advanced', 'c1', 'c2'],
        },
      ],
      questions: {
        'uz-Latn':
          'Hozirgi darajangiz qanday: boshlang‘ich, o‘rta yoki yuqori?',
        'uz-Cyrl': 'Ҳозирги даражангиз қандай: бошланғич, ўрта ёки юқори?',
        ru: 'Какой у вас сейчас уровень: начальный, средний или продвинутый?',
        en: 'What is your current level: beginner, intermediate or advanced?',
      },
    },
    {
      key: 'preferredTime',
      type: 'enum',
      description: 'Preferred lesson time.',
      options: [
        { value: 'morning', synonyms: ['ertalab', 'утром', 'утро', 'morning'] },
        {
          value: 'afternoon',
          synonyms: ['tushdan keyin', 'kunduzi', 'днём', 'днем', 'afternoon'],
        },
        {
          value: 'evening',
          synonyms: ['kechqurun', 'kechki', 'вечером', 'вечер', 'evening'],
        },
        {
          value: 'weekend',
          synonyms: [
            'dam olish kuni',
            'shanba',
            'yakshanba',
            'выходные',
            'weekend',
          ],
        },
      ],
      questions: {
        'uz-Latn':
          'Qaysi vaqtda o‘qish sizga qulay: ertalab, kunduzi, kechqurun yoki dam olish kunlari?',
        'uz-Cyrl':
          'Қайси вақтда ўқиш сизга қулай: эрталаб, кундузи, кечқурун ёки дам олиш кунлари?',
        ru: 'В какое время вам удобно заниматься: утром, днём, вечером или в выходные?',
        en: 'When is it convenient for you to study: morning, afternoon, evening or weekends?',
      },
    },
    {
      key: 'studentAge',
      type: 'integer',
      description: 'Age of the student in years, if mentioned.',
      min: 3,
      max: 99,
      questions: {
        'uz-Latn': "O'quvchining yoshi nechada?",
        'uz-Cyrl': 'Ўқувчининг ёши нечада?',
        ru: 'Сколько лет ученику?',
        en: 'How old is the student?',
      },
    },
    {
      key: 'goal',
      type: 'text',
      description:
        'Learning goal in a few words (e.g. "exam preparation", "study abroad", "work").',
      maxLength: 120,
      questions: {
        'uz-Latn': "O'qishdan asosiy maqsadingiz nima?",
        'uz-Cyrl': 'Ўқишдан асосий мақсадингиз нима?',
        ru: 'Какая у вас основная цель обучения?',
        en: 'What is your main goal for studying?',
      },
    },
  ],
});
