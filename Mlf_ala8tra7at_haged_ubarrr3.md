# ملف اقتراحات مميزات الراكب — Ubar (v3) — **معتمد**

> الهدف: مميزات جديدة للراكب داخل **نفس التطبيق الحالي** (Node/Express + PostgreSQL + Socket.IO + HTML/JS) بدون إنشاء تطبيق آخر.

> ملاحظة أمنية: هذا الملف **لا يحتوي ولا يجب أن يحتوي** على أي بيانات اتصال (DB URLs / passwords) أو أسرار.

---

## 1) مبادئ اعتماد v3

1) **بدون صفحات جديدة**: التنفيذ داخل الصفحات الحالية (index/settings/support/profile) وبنفس نمط UI الحالي.
2) **تستفيد من الموجود**: (Support Tickets + Receipt + Wallet Ledger + Realtime rooms) بدل بناء أنظمة منفصلة.
3) **قابلية تنفيذ واقعية**: كل ميزة لها DB + API + مكان واضح في UI.
4) **خصوصية واضحة**: Opt-in لأي بيانات إضافية، وRedaction حسب الدور.

---

## 2) ما هو موجود بالفعل (لعدم التكرار)

هذه العناصر موجودة بالفعل في الريبو (v1/v2) ولا نعيد اقتراحها هنا:
- Safety Capsule + مشاركة الرحلة + OK/Help/Emergency + Route deviation
- Pickup handshake (كود + QR)
- Guardian check-ins + trusted contacts
- Pickup hubs + pickup suggestions + ترجيح hubs حسب الإتاحة
- Accessibility Profile + Snapshot + Driver Ack + Messaging Board + Voice-first + Beacon + Feedback
- Price lock + Budget envelope + Family members + Note templates + Favorites + Loyalty + Scheduled rides
- Support tickets (مع مرفق اختياري)
- Receipts endpoint
- Offers validation

المرجع: (v1/v2)
- Mlf_ala8tra7at_haged_ubar1.md
- Mlf_ala8tra7at_hageddd_ubar2.md

---

## 3) حزمة المميزات الجديدة (v3)

### (A) Saved Places — أماكن محفوظة (بيت/شغل/أماكن)
**الفكرة**: الراكب يحفظ أماكن ثابتة واسمها (Home/Work/Custom) عشان الطلب يبقى أسرع وأقل غلط.

**ليه مختلفة عندنا؟**
- هتدخل في تدفق الطلب الحالي من غير صفحة جديدة.
- تتحول لـ”اقتراحات” مباشرة في شاشة الطلب.

**تنفيذ متوقع**
- DB: جدول `passenger_saved_places` (user_id, label, name, lat, lng, notes, created_at)
- API:
  - `GET /api/passengers/me/places`
  - `POST /api/passengers/me/places`
  - `DELETE /api/passengers/me/places/:id`
- UI:
  - أزرار “البيت / الشغل / المحفوظة” داخل شاشة إنشاء الرحلة في index.
  - إدارة بسيطة داخل settings (إضافة/حذف).

---

### (B) Trip Templates — قوالب رحلات جاهزة
**الفكرة**: الراكب يحفظ “قالب رحلة” (وجهة + ملاحظات + طريقة دفع + تفضيلات) ويعمل “طلب بنفس القالب” بضغطة.

**تنفيذ متوقع**
- DB: جدول `passenger_trip_templates` (user_id, title, payload_json, created_at)
- API:
  - `GET /api/passengers/me/trip-templates`
  - `POST /api/passengers/me/trip-templates`
  - `DELETE /api/passengers/me/trip-templates/:id`
- UI:
  - قائمة “قوالب” صغيرة في شاشة الطلب + زر “حفظ كقالب” بعد إنشاء رحلة.

---

### (C) Lost & Found — المفقودات (مربوط بالرحلة + الدعم)
**الفكرة**: بدل ما الراكب يتصل/يدوّر، يعمل “بلاغ مفقودات” مرتبط برحلة معينة ويتابع الحالة.

**ليه قوية؟**
- تتبنى على Support Tickets الموجودة بدل إنشاء نظام جديد.

**تنفيذ متوقع**
- DB: جدول `lost_items` (trip_id, user_id, description, contact_method, status, created_at, updated_at)
- API:
  - `POST /api/trips/:id/lost-items` (passenger)
  - `GET /api/support/me/lost-items` (passenger)
  - `GET /api/admin/lost-items` (admin)
  - `PATCH /api/admin/lost-items/:id` (admin)
- UI:
  - زر داخل إيصال الرحلة: “نسيت حاجة؟”
  - متابعة الحالات داخل support.html (تبويب بسيط بجانب التذاكر).

---

### (D) Tipping بعد الرحلة — بقشيش (اختياري)
**الفكرة**: بعد انتهاء الرحلة، الراكب يقدر يضيف Tip للسائق.

**تنفيذ متوقع**
- DB: جدول `trip_tips` (trip_id, user_id, driver_id, amount, method, created_at)
- تكامل:
  - لو الدفع بالمحفظة: إدراج `wallet_transactions` reference_type='tip'
  - تحديث driver earnings/stats بنفس مسار الإيرادات.
- API:
  - `POST /api/trips/:id/tip` (passenger)
- UI:
  - أزرار Tip سريعة بعد completion + تظهر في receipt.

---

### (E) Ride Pass / Subscription — باقة/اشتراك رحلات
**الفكرة**: الراكب يشترك في باقة (مثلاً خصم ثابت لمدة/عدد رحلات/سقف) تطبق تلقائيًا داخل إنشاء الرحلة.

**ليه مناسبة للمدينة + بين المدن؟**
- داخل المدينة: باقات يومية/أسبوعية.
- بين المدن: باقة “رحلات طويلة” بخصم أو نقاط.

**تنفيذ متوقع**
- DB: جدول `passenger_ride_passes` (user_id, type, rules_json, valid_from, valid_to, status)
- API:
  - `GET /api/passengers/me/passes`
  - `POST /api/passengers/me/passes` (شراء/تفعيل)
- تطبيق الخصم:
  - أثناء `POST /api/trips` يتم تقييم pass/offer ثم تخزين أثره في trip.
- UI:
  - عرض حالة الباقة داخل settings + شارة بسيطة في شاشة الطلب.

---

### (F) Fare Review / Refund Request — مراجعة أجرة/طلب استرجاع
**الفكرة**: لو الراكب حس إن في مشكلة في الأجرة/المسافة/الانحراف، يقدم طلب مراجعة مربوط بالرحلة.

**تنفيذ متوقع**
- DB: جدول `refund_requests` (trip_id, user_id, reason, amount_requested, status, resolution_note, created_at, updated_at)
- API:
  - `POST /api/trips/:id/refund-request` (passenger)
  - `GET /api/support/me/refund-requests` (passenger)
  - `GET /api/admin/refund-requests` (admin)
  - `PATCH /api/admin/refund-requests/:id` (admin approve/reject)
- تكامل محفظة:
  - عند approve يتم credit للراكب عبر `wallet_transactions` reference_type='refund'.

---

### (G) Smart Rebook — إعادة محاولة ذكية بعد الإلغاء/التأخير
**الفكرة**: بدل ما الراكب يعيد طلب من الصفر، زر “إعادة المحاولة” ينسخ نفس إعدادات الرحلة (أو قالب) ويبدأ تدفق جديد.

**تنفيذ متوقع**
- API:
  - `POST /api/trips/:id/rebook`
- Realtime:
  - إرسال event للراكب على `user:<id>` يوضح حالة المحاولة.
- UI:
  - يظهر الزر فقط عند cancelled أو timeout في شاشة الرحلة.

---

## 4) ترتيب التنفيذ المقترح (Phasing)

- Phase 1 (سريع التأثير): Saved Places + Trip Templates
- Phase 2 (ثقة/دعم): Lost & Found + Refund Requests
- Phase 3 (تحسين الإيراد/الولاء): Tipping + Ride Pass
- Phase 4 (اعتمادية): Smart Rebook

---

## 5) Checklist قبل أي Commit (إلزامي)

- تشغيل اختبارات الـAPI: `npm test`
- تشغيل build: `npm run build` (حاليًا لا يوجد build step، لكنه smoke check)
- Smoke test يدوي سريع:
  1) إنشاء رحلة
  2) إنهاء رحلة
  3) استدعاء receipt
  4) تجربة (Lost item / Refund request / Tip) حسب الميزة التي تم تنفيذها

---

## 6) ملاحظات تنفيذية قصيرة

- كل المميزات دي تُنفَّذ داخل نفس المشروع الحالي.
- أي endpoints جديدة يجب أن تستخدم نفس auth/roles ونفس pattern الموجود في السيرفر.
- يفضّل توسيع `test-passenger-features.js` لتغطية endpoints الجديدة قبل أي دمج.
