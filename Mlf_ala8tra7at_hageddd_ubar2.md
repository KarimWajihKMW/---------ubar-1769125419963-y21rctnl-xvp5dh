# ملف اقتراحات مميزات الراكب — Ubar (v2) — **معتمد**

> الهدف: إضافة مميزات للراكب **غير مكررة** داخل التطبيق الحالي، وتكون صعبة التقليد لأنها تربط (ملف إتاحة + تدفّق رحلة + توثيق + Realtime) داخل نفس بنية النظام (Node/Express + PostgreSQL + Socket.IO).

> ملاحظة: هذا الملف لا يحتوي ولا يجب أن يحتوي على أي بيانات اتصال (DB URLs / passwords) أو أسرار.

---

## 1) مبادئ اعتماد المميزات

1) **تشتغل في كل الرحلات** (مش سيناريوهات نادرة فقط).
2) **Accessibility-first**: تخدم ذوي الإعاقة وكبار السن وضعف السمع/البصر، وفي نفس الوقت تفيد المستخدم العادي.
3) **Opt-in واضح** لأي بيانات إضافية (مستوى “جريء” لكن بموافقة).
4) **بدون صفحات جديدة**: التنفيذ داخل صفحات الراكب الحالية (index/settings/profile) وبنفس نمط API الحالي.
5) **Realtime-first**: أي حالة حساسة أثناء الرحلة تُبث عبر Socket.IO بنفس Rooms الحالية (user:<id>, trip:<id>).

---

## 2) ما هو موجود بالفعل (لعدم التكرار)

هذه العناصر موجودة بالفعل في الريبو (أو موثّقة كمنفّذة في v1) ولا نعيد اقتراحها هنا:
- Safety Capsule + مشاركة الرحلة + OK/Help/Emergency + Route deviation
- Pickup handshake (كود + QR)
- Guardian check-ins + trusted contacts
- Pickup hubs + pickup suggestions
- Price lock + Budget envelope + Family members + Note templates + Favorites + Loyalty + Scheduled rides

المرجع: ملف v1: Mlf_ala8tra7at_haged_ubar1.md

---

## 3) حزمة المميزات المعتمدة (v2)

### (A) Accessibility Profile — ملف إتاحة (Server-backed)
**الفكرة**: الراكب يبقى عنده “ملف إتاحة” دائم على السيرفر بدل localStorage.
- أمثلة حقول:
  - ضعف بصر (Voice prompts)
  - ضعف سمع (Text-first / no calls)
  - كرسي متحرك (Wheelchair)
  - يحتاج وقت إضافي للركوب/النزول
  - لغة بسيطة/تعليمات مختصرة

**التميّز**: الملف يُستخدم تلقائيًا داخل الرحلة ويؤثر على الاقتراحات والتواصل.

---

### (B) Trip Accessibility Snapshot — لقطة إتاحة داخل الرحلة
**الفكرة**: عند إنشاء الرحلة يتم نسخ Snapshot من ملف الإتاحة داخل بيانات الرحلة.
- يمنع تغيير الشروط وسط الرحلة بدون قصد.
- يسهل الدعم/النزاعات: “هذه هي احتياجات الرحلة وقت الإنشاء”.

---

### (C) Driver Accessibility Acknowledgement — تأكيد السائق
**الفكرة**: السائق يؤكد داخل الرحلة أنه اطّلع على احتياجات الإتاحة الأساسية.
- يتم تسجيلها في الرحلة + بث Realtime للراكب.

**التميّز**: توثيق “الاطلاع” يقلل سوء الفهم ويرفع الثقة.

---

### (D) Accessible Messaging Board — لوحة رسائل موجهة (بديل شات عام)
**الفكرة**: بدل “شات مفتوح” تقليدي، نعمل لوحة رسائل قصيرة مرتبطة بالرحلة:
- رسائل أحادية/ثنائية لكنها مقيدة بقوالب (Templates) + نص حر قصير.
- تركيزها على: الوصول، الالتقاء، تعليمات واضحة.

**التميّز**: أقل إساءة/تشتيت من شات كامل، وأسهل لضعف السمع/لغة بسيطة.

---

### (E) Voice-First Passenger Mode — وضع الصوت للراكب
**الفكرة**: تفعيل (اختياري) لنطق أحداث الرحلة المهمة:
- تم إسناد السائق
- السائق على بعد X دقائق
- تم بدء الرحلة / الانتهاء
- تنبيهات حساسة (انحراف مسار…)

**التميّز**: مفيد لضعف البصر بدون أي أجهزة إضافية.

---

### (F) Pickup Beacon Mode — وضع “الإشارة” عند الالتقاء
**الفكرة**: زر أثناء الانتظار يجعل الهاتف يعمل كمنارة:
- وميض شاشة + اهتزاز + صوت قصير
- رمز بصري بسيط يظهر للسائق (غير بيانات شخصية)

**التميّز**: يحل مشكلة الالتقاء خصوصًا لضعف السمع/الزحام.

---

### (G) Accessible Pickup Hubs Ranking — تفضيل نقاط الالتقاء المناسبة
**الفكرة**: عندما يكون ملف الإتاحة يتطلب ذلك، يتم ترجيح pickup hubs المناسبة:
- منحدر/سهولة مرور
- إضاءة أفضل
- أقل ازدحام

**التميّز**: ليس “مجرد hubs” بل hubs مناسبة فعليًا للحالة.

---

### (H) Emergency Info Card (Opt-in) — بطاقة طوارئ (اختيارية)
**الفكرة**: الراكب (اختياريًا) يحفظ بطاقة طوارئ:
- اسم جهة اتصال + ملاحظة طبية مختصرة (حساسية…)

**قيد مهم**:
- لا تظهر للسائق بشكل مفتوح.
- تُستخدم فقط في حالات Safety/Emergency وبصيغ مختصرة.

---

### (I) Accessibility Feedback بعد الرحلة — تغذية راجعة للإتاحة
**الفكرة**: بعد انتهاء الرحلة، نموذج سريع (غير التقييم العام):
- “هل تم احترام احتياجات الإتاحة؟”
- سبب مختصر

**التميّز**: بيانات تشغيلية لتحسين الجودة + سياسات مطابقة للسائقين.

---

## 4) تغييرات تقنية متوقعة (ملخص تنفيذ)

### A) جداول/أعمدة (اقتراح)
- passenger_accessibility_profiles
- passenger_emergency_profiles
- trip_messages
- trip_accessibility_feedback
- أعمدة داخل trips: accessibility_snapshot_json, accessibility_ack_at/by
- أعمدة داخل pickup_hubs: wheelchair_accessible, ramp_available, low_traffic (حسب الحاجة)

### B) Endpoints (اقتراح)
- GET/PUT /api/passengers/me/accessibility
- GET/PUT /api/passengers/me/emergency-profile
- GET/POST /api/trips/:id/messages
- POST /api/trips/:id/accessibility-feedback

### C) Socket.IO events (اقتراح)
- trip_accessibility_ack
- trip_message

---

## 5) حدود الخصوصية والامتثال (مهم)

- أي بيانات إضافية = **Opt-in** + إمكانية إيقاف/حذف.
- بطاقة الطوارئ لا تُعرض علنًا ولا تُستخدم إلا عند حدث Safety/Emergency.
- لا يتم تخزين تسجيل صوت افتراضيًا. لو تم اقتراحه مستقبلًا: يكون opt-in منفصل + سياسة احتفاظ واضحة.

---

## 6) معايير قبول (Acceptance Criteria)

- الراكب يقدر يقرأ/يحدّث ملف الإتاحة من الإعدادات، وتكون محفوظة على السيرفر.
- عند إنشاء رحلة جديدة، يظهر للراكب أن “احتياجات الإتاحة تم تضمينها” (Snapshot) مع إمكانية معاينة مختصرة.
- السائق يرسل تأكيد الاطلاع، والراكب يستلم event لحظي.
- لوحة الرسائل تعمل عبر API + Socket.IO وتظهر داخل شاشة الرحلة.
- Voice-first يعمل كخيار بدون كسر تجربة المستخدم العادي.
- Pickup beacon يعمل بدون صلاحيات إضافية معقّدة.

---

## 7) Checklist قبل أي Commit (إلزامي)

- تشغيل اختبارات الـAPI: npm test
- تشغيل build: npm run build
- اختبار يدوي سريع:
  1) تحديث ملف الإتاحة
  2) إنشاء رحلة
  3) إرسال/استقبال رسالة رحلة (Realtime)
  4) تأكيد السائق للاطلاع (Realtime)

---

## 8) نطاق التنفيذ (Phasing)

- Phase 1 (أساسي): Accessibility Profile + Snapshot + Driver Ack
- Phase 2 (تجربة): Messaging Board + Voice-first + Beacon
- Phase 3 (تحسين): Hubs ranking + Emergency card + Feedback

---

## 9) Implementation Status (داخل هذا الريبو)

تم تنفيذ كل عناصر v2 المذكورة أعلاه داخل التطبيق الحالي (بدون صفحات جديدة)، بتاريخ: 2026-02-18.

### ✅ Database / Schema
- تم إضافة جداول/أعمدة داخل `ensurePassengerFeatureTables()` في `server.js`:
  - `passenger_accessibility_profiles`
  - `passenger_emergency_profiles`
  - `trip_messages`
  - `trip_accessibility_feedback`
  - أعمدة داخل `trips`: `accessibility_snapshot_json`, `accessibility_snapshot_at`, `accessibility_ack_at`, `accessibility_ack_by_driver_id`
  - أعمدة داخل `pickup_hubs`: `wheelchair_accessible`, `ramp_available`, `low_traffic`, `good_lighting`

### ✅ API Endpoints
- Accessibility Profile:
  - `GET /api/passengers/me/accessibility`
  - `PUT /api/passengers/me/accessibility`
- Emergency Info Card:
  - `GET /api/passengers/me/emergency-profile`
  - `PUT /api/passengers/me/emergency-profile`
- Trip Accessibility Snapshot:
  - يتم نسخ Snapshot تلقائيًا داخل `POST /api/trips` (عند إنشاء رحلة)
- Driver Accessibility Acknowledgement:
  - `POST /api/trips/:id/accessibility-ack`
- Accessible Messaging Board:
  - `GET /api/trips/:id/messages`
  - `POST /api/trips/:id/messages`
- Accessibility Feedback:
  - `POST /api/trips/:id/accessibility-feedback`

### ✅ Socket.IO Events
- `trip_accessibility_ack` (Room: `trip:<id>` + `user:<id>`)
- `trip_message` (Room: `trip:<id>`)

### ✅ UI (بدون صفحات جديدة)
- `settings.html/settings.js`: إضافة وحفظ/تحميل
  - ملف الإتاحة (Accessibility Profile)
  - بطاقة الطوارئ (Opt-in)
- `index.html/script.js`:
  - عرض Snapshot للراكب داخل شاشة الرحلة
  - تأكيد السائق داخل لوحة السائق
  - لوحة رسائل موجهة (Templates) داخل شاشة المراسلة
  - Voice-first Passenger Mode (Web Speech API) عند تفعيل `voice_prompts`
  - Pickup Beacon Mode داخل شاشة انتظار السائق
  - نموذج Accessibility Feedback بعد الرحلة
  - ترجيح اقتراح Pickup Hubs تلقائيًا عند وجود احتياجات إتاحة

### ✅ Tests
- تحديث اختبار `test-passenger-features.js` لتغطية:
  - Accessibility profile + Snapshot
  - Emergency profile + emergency response
  - Trip messages
  - Accessibility ack
  - Accessibility feedback
