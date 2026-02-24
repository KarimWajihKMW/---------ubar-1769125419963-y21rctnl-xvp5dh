# ملف اقتراحات الإدارة (معتمد) — Akwadra / Ubar

**اسم الملف:** Mlf_ala8tra7at_administration_haged_ubar

**الحالة:** ✅ معتمد

**التاريخ:** 2026-02-24

**الإصدار:** v1.0

---

## 1) الهدف
بناء إدارة (Admin) مختلفة عن أي تطبيق منافس عبر **لوحة تشغيل ميداني** + **صندوق قضايا موحّد** + **أتمتة Playbooks** + **صلاحيات دقيقة** — مع الاعتماد أولاً على الـ APIs الموجودة بالفعل لتسريع الإنجاز.

---

## 2) نطاق العمل (Scope)
- **UI أولاً** فوق الـ endpoints الموجودة في [server.js](server.js) + اعتماد [api-service.js](api-service.js) لإرسال `Authorization: Bearer <token>`.
- إضافة مميزات “تشغيل ميداني” (Ops) تربط الرحلة/السائق/الراكب/المحفظة/الأدلة في شاشة واحدة.
- تحسين صلاحيات الأدمن من “admin واحد” إلى أدوار متعددة (RBAC).

**خارج النطاق حالياً (مؤقتاً):** بناء نظام ML/تنبؤ كبير أو إعادة تصميم كاملة للواجهة.

---

## 3) مميزات تميّز الإدارة (Unique Admin Features)

### (A) Ops Radar — رادار عمليات لحظي (خريطة تشغيل)
**الفكرة:** شاشة خريطة واحدة تجمع: السائقين الحيين + الطلبات المعلّقة + إشارات السلامة + البلاغات المفتوحة.

**تعتمد على الموجود:**
- مواقع السائقين: أعمدة `drivers.last_lat/last_lng/last_location_at`.
- Pending Rides: `/api/pending-rides` + أدوات cleanup.
- Safety/Incidents: `/api/admin/incidents` + جداول السلامة.

**قيمة التميز:** إدارة “تشوف وتتصرف” بدل جداول ثابتة.

---

### (B) Case Inbox — صندوق قضايا موحّد
**الفكرة:** Inbox واحدة تجمع تلقائياً (وتربط) الحالات:
- Support Tickets
- Refund Requests
- Lost Items
- Trip Incidents

**مميزات داخل الـ Inbox:**
- بحث موحّد (بالـ trip_id / user_id / driver_id / رقم الهاتف).
- “إجراءات سريعة” من نفس المكان (تحديث الحالة، إضافة ملاحظة، تنفيذ Refund/Wallet credit عند السماح).

**تعتمد على الموجود:**
- `/api/admin/support/tickets`
- `/api/admin/refund-requests`
- `/api/admin/lost-items`
- `/api/admin/incidents`

---

### (C) Incident Evidence Bundle — حزمة أدلة البلاغ (للأمان والثقة)
**الفكرة:** عند فتح بلاغ، تظهر “حزمة أدلة” جاهزة:
- Timeline/Events
- Messages
- Proofs (مثل wait proofs)
- Audio metadata + تنزيل التسجيل عند الحاجة

**تعتمد على الموجود:**
- `/api/admin/trips/:tripId/driver-audio/:recId/download`
- جداول timeline/messages/safety الموجودة

**قيمة التميز:** حل أسرع + قرارات موثّقة + قابلية تدقيق.

---

### (D) Playbooks — أتمتة تشغيل داخل الإدارة (التميّز الحقيقي)
**الفكرة:** قواعد بسيطة: (شرط) → (إجراء) بدون تدخل يدوي في كل مرة.

**أمثلة Playbooks (MVP):**
- Refund عالي القيمة → يتطلب موافقة “Finance” + يفتح Ticket “Support” + يضيف Audit.
- بلاغ Safety من نوع SOS → يرفع أولوية القضية + يطلب “Guardian check” + يقيّد تعديل بعض الحقول إلا لسوبر أدمن.
- سائق تكرر عليه شكاوى → يظهر كـ “Risk Flag” في Ops Radar.

---

### (E) RBAC — صلاحيات متعددة للأدمن
**الفكرة:** بدل `admin` واحد، أدوار مثل:
- `super_admin`
- `support_agent`
- `safety_ops`
- `finance_ops`
- `ops_manager`

**المبدأ:** كل endpoint حساس يتطلب Permission محددة، وليس مجرد Role عام.

---

### (F) Pickup Hubs Control + قياس التبنّي
**الفكرة:** إدارة نقاط التجمع (Pickup Hubs) + لوحة قياس:
- تفعيل/تعطيل hubs
- خصائص الأمان/الإتاحة (إضاءة/منحدر/كرسي متحرك)
- نسب قبول/رفض الاقتراحات

**تعتمد على الموجود:**
- جدول `pickup_hubs`
- `/api/admin/pickup-hubs`
- `trip_pickup_suggestions`

---

## 4) ملاحظات تنفيذ مهمة (تسريع + استغلال الموجود)
- توحيد استدعاءات الإدارة على [api-service.js](api-service.js) لتفادي أخطاء التوكن.
- صفحات إدارة حالياً محتاجة إصلاح توكن (على الأقل):
  - [admin-driver-earnings.html](admin-driver-earnings.html)
  - [pending-rides.html](pending-rides.html)

---

## 5) متطلبات أمان “قبل التوسع” (ضرورية)
> الهدف هنا حماية الإدارة والنظام قبل إضافة قدرات أكبر.

- إغلاق أو تأمين endpoints غير محمية (خصوصاً sync).
- منع إرجاع بيانات حساسة (مثل كلمات مرور/هاش) في أي endpoint عام.
- مراجعة إتاحة ملفات `/uploads` (تجنب إظهار مستندات حساسة بشكل public).
- تقليل CORS عند الإنتاج حسب الدومينات الفعلية.

---

## 6) مراحل تنفيذ مقترحة (UI أولاً)

**Phase 1 (سريع):**
- إصلاح صفحات الإدارة التي لا ترسل Bearer token.
- إضافة UI أولي لـ Case Inbox على endpoints الموجودة.

**Phase 2:**
- Ops Radar (خريطة تشغيل) + ربطها بـ incidents/pending rides.

**Phase 3:**
- RBAC (صلاحيات متعددة) + Audit log بسيط للأفعال الإدارية.

**Phase 4:**
- Playbooks (MVP) + قياس نتائجها.

---

## 7) معايير قبول (Acceptance Criteria)
- كل شاشة إدارة ترسل `Authorization` تلقائياً ولا تعمل بدون توكن صالح.
- الأدمن يقدر يشوف: Support/Refund/Lost/Incidents من Inbox واحد ويغيّر الحالة بنجاح.
- Ops Radar تعرض بيانات لحظية (على الأقل: مواقع سائقين + pending rides).
- RBAC يمنع أي دور من تنفيذ عمليات خارج صلاحياته.

---

## 8) الاختبار قبل الدمج (حسب سياسة المشروع)
- اختبار الـ API والـ endpoints الجديدة/المعدلة قبل أي commit.
- تشغيل:
  - `npm test`
  - `npm run build`
- ثم commit + push إلى `main`.

---

## 9) توقيع الاعتماد
- **الاسم:** ______________________
- **الدور:** ______________________
- **التاريخ:** ____________________
- **ملاحظات:** ____________________
