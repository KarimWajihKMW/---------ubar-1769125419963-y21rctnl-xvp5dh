# ملف اقتراحات مميزات الراكب — Ubar (v1)

> الهدف: مميزات “مش موجودة في أي تطبيق تاني” *بشكل عملي* ومناسبة للـBackend الموجود عندنا (Node/Express + PostgreSQL + Socket.IO).

## 1) الميزة الأقوى المقترحة (MVP = ميزة واحدة ضخمة)

### Safety Capsule + Live Match Timeline
ميزة واحدة باسم واضح (مثلاً: **Safety Capsule**) لكن بتقدّم حاجتين مع بعض:

1) **Live Match Timeline** أثناء انتظار السائق
- الراكب يشوف “تايم لاين” لحظي لعملية الإسناد بدون كشف بيانات حساسة.
- أمثلة أحداث تظهر للراكب:
  - تم إرسال الطلب للسائقين القريبين
  - سائق رفض الطلب
  - سائق قبل الطلب
  - تم إسناد الرحلة

2) **Safety Capsule** بعد (وأثناء) الرحلة
- “تقرير أمان” جاهز للمشاركة أو للدعم (Support) في حالة مشكلة.
- يجمع:
  - تحقق الـPickup Handshake (تم/لم يتم + وقت التحقق)
  - سجل أحداث الأمان (OK/Help/Emergency) بوقت حدوثها
  - Guardian check-ins (المجدول/المرسَل/الفشل)
  - Route deviation config للرحلة (enabled/thresholds)
  - رابط مشاركة حيّ للرحلة (Trip share) إن وجد

**ليه ده مختلف؟**
- أغلب التطبيقات عندها زر طوارئ وخلاص؛ إنما “Safety Capsule” بتعمل **سجل مُثبت** ومُوحّد وده بيفرق جدًا في: الثقة + حل الشكاوى + الحماية.

---

## 2) اقتراحات مميزات ركّاب “نادرة” (للتطوير بعد MVP)

### أ) العائلات والأطفال (Family Guardrails)
- **حدود إنفاق تلقائية** عند الحجز لأحد أفراد الأسرة (daily/weekly limits) + تنبيه قبل تجاوز الحد.
- **صلاحيات**: مين يقدر يحجز لمين + مين يقدر يشوف الرحلات.

### ب) تجربة فخمة/مريحة (Comfort)
- **Quiet Mode**: بدون مكالمات/رسائل إلا للطوارئ + auto-note templates.
- **Pickup Negotiation v2**: تفضيل “أوضح نقطة/أأمن نقطة” عند اقتراح hubs.

### ج) توفير وتسعير ذكي
- **Trip Budget Envelope**: ميزانية للرحلة/الأسبوع (خصوصًا لمن يعتمد على Wallet) مع تحويل تلقائي لـcash عند نفاد الميزانية.
- **Offer Eligibility** مرتبط بالسلوك (مثلاً: الالتزام بالـPickup Hubs) بدل مجرد كوبون.

### د) ثقة وجودة السائق
- **Night Safety Policy**: الرحلات الليلية لا تُسند إلا لسائقين بمعايير داخلية (approved + rating threshold + حديث الموقع).

---

## 3) تغييرات تقنية مقترحة (Backend/Realtime)

### A) Endpoint جديد لتجميع Safety Capsule
- `GET /api/trips/:id/safety/capsule`

**يرجع** (اقتراح شكل response):
```json
{
  "success": true,
  "data": {
    "trip": { "id": "...", "status": "...", "driver_id": 1 },
    "handshake": { "verified_at": "...", "verified_by": 12 },
    "share": { "url": "/api/share/...", "expires_at": "..." },
    "deviation_config": { "enabled": true, "deviation_threshold_km": 2.5, "stop_minutes_threshold": 6 },
    "timeline": [
      { "type": "safety_event", "event_type": "rider_ok_confirmed", "created_at": "..." },
      { "type": "guardian_checkin", "status": "scheduled", "due_at": "..." }
    ]
  }
}
```

**مصادر البيانات** (موجودة بالفعل في DB):
- `trips.pickup_verified_at/pickup_verified_by`
- `trip_safety_events`
- `trip_shares`
- `trip_guardian_checkins`
- `trip_route_deviation_configs`

### B) Socket.IO events للـLive Match Timeline
- Events مقترحة:
  - `pending_request_update`
  - `trip_assigned`

**Room strategy**
- أفضل: غرفة للمستخدم `user:<id>` (لأن pending request ممكن يبقى قبل trip أو قبل join trip room)
- بديل: غرفة `trip:<id>` بعد إنشاء الرحلة.

---

## 4) UI Minimal (بدون صفحات جديدة)

- إضافة قسم صغير داخل شاشة الرحلة/الإيصال:
  - زر: **تقرير الأمان (Safety Capsule)**
  - عرض timeline بسيط + share link

---

## 4.1) حالة التنفيذ في الريبو الحالي (موجود بالفعل)

> ملحوظة: الجزء ده للتوثيق السريع “إيه اتعمل فعلاً” علشان ما نعيدش اقتراح حاجة اتنفّذت.

- ✅ Endpoint: `GET /api/trips/:id/safety/capsule`
- ✅ Socket.IO: أحداث `pending_request_update` و `trip_assigned` للـLive Match Timeline
- ✅ UI minimal لتقرير الأمان داخل شاشة تفاصيل الرحلة (زر + share link + timeline)
- ✅ تجميع البيانات من: `trips.pickup_verified_at/pickup_verified_by` + `trip_safety_events` + `trip_guardian_checkins` + `trip_route_deviation_configs` + `trip_shares`

---

## 4.2) اقتراحات إضافية سريعة (Low effort / High impact)

1) **Timeline event codes بدل النص**
- بدل ما السيرفر يبعت نصوص فقط، يبعت `event_code` ثابت + بيانات بسيطة؛ والـUI تعمل ترجمة/عرض عربي حسب الحالة.

2) **Redaction حسب الدور**
- نفس Endpoint يرجع بيانات “مخففة” للراكب (بدون أي identifiers حساسة) وبيانات أوسع للـAdmin/Support.

3) **Export / Copy capsule**
- زر صغير داخل نفس القسم: “نسخ تقرير الأمان” (JSON مختصر أو نص منسّق) للمشاركة مع الدعم.

4) **Capsule snapshot عند اكتمال الرحلة**
- تخزين Snapshot مختصر (أو hash) عند `completed` لتسهيل دعم الشكاوى (بدون بناء نظام معقد).

---

## 5) Checklist للاختبار قبل أي Commit

### Tests (API)
- تشغيل قاعدة بيانات اختبار (محليًا) ثم:
  - `npm test`

### Build
- `npm run build`

### Smoke test يدوي سريع
1) إنشاء رحلة
2) إنشاء share link
3) إرسال safety event (OK/Help)
4) استدعاء `GET /api/trips/:id/safety/capsule` والتأكد أن timeline يظهر مرتب

---

## 6) ملاحظة أمنية مهمة

- بيانات اتصال PostgreSQL العامة (URL/username/password) **لازم تفضل Secrets / ENV فقط**.
- ممنوع تتحط في ملفات داخل الريبو أو في أي commit.
