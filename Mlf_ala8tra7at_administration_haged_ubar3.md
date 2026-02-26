# Mlf_ala8tra7at_administration_haged_ubar3

## اعتماد خطة اقتراحات إدارة جديدة وحصرية

تم اعتماد التوجه التالي:
- **الأولوية:** تقليل الاحتيال والمخاطر.
- **المدى:** ميزات متقدمة فقط.
- **النطاق:** أدوات إدارة مع تأثير مباشر على تجربة الكابتن والراكب.
- **الاستراتيجية:** تقديم ميزات جديدة غير مكررة وغير موجودة في الملفات السابقة.

## خط الأساس الحالي (ملخص)
المنظومة الحالية تحتوي بالفعل على قدر كبير من أدوات الإدارة (Case Inbox / Ops Radar / Incidents / Audit / RBAC / Policy Sandbox / Crisis Mode / Executive Decisions)، لذلك أي تطوير جديد يجب أن يكون فوق الموجود وليس تكرارًا له.

## الوثيقة التنفيذية النهائية (تم تحويلها للتطبيق)

تم تنفيذ وحدة إدارية جديدة داخل التطبيق باسم **Risk Command Center** مع 7 ميزات مكافحة احتيال/مخاطر جديدة بالكامل، ومتكاملة مع RBAC وAudit والـ API.

### 1) Refund Burst Chain Guard
- **سبب التفرد:** يكشف سلاسل Refund المتكررة زمنيًا قبل النزيف المالي.
- **Trigger:** ≥3 طلبات Refund لنفس الراكب خلال 6 ساعات وبإجمالي ≥250.
- **قرار إداري:** تحويل الحالة تلقائيًا لـ Risk Review + متابعة Finance.
- **إجراء تلقائي:** إنشاء Alert + Lock نوع `refund_hold` على المستخدم لفترة محددة.
- **الأثر القابل للقياس:** خفض معدل `refund_fraud_rate_daily`.

### 2) Driver-Passenger Collusion Ring Detector
- **سبب التفرد:** يكتشف أنماط التواطؤ بين نفس الكابتن/الراكب بتكرار غير طبيعي.
- **Trigger:** تكرار زوج كابتن-راكب بعدد كبير خلال 14 يومًا.
- **قرار إداري:** فتح تحقيق Collusion مع أولوية عالية.
- **إجراء تلقائي:** إنشاء Alert + Lock نوع `incentive_hold` + رفع مستوى مخاطر الكابتن.
- **الأثر القابل للقياس:** خفض `synthetic_trip_ratio`.

### 3) Impossible Trip Velocity Sentinel
- **سبب التفرد:** يمنع الرحلات الوهمية عبر مقارنة المسافة بزمن الرحلة.
- **Trigger:** سرعة محسوبة أعلى من الحد (افتراضي 140 كم/س) لمسافة معتبرة.
- **قرار إداري:** تعليق التسوية المالية للرحلة للمراجعة.
- **إجراء تلقائي:** Alert + Lock نوع `payout_review` على الرحلة.
- **الأثر القابل للقياس:** تقليل `ghost_trip_rate`.

### 4) Wallet Churn Abuse Shield
- **سبب التفرد:** يكشف تدوير رصيد wallet (credit/debit churn) بصافي منخفض وحجم مرتفع.
- **Trigger:** كثافة عمليات wallet خلال ساعة مع صافي حركة شبه صفري.
- **قرار إداري:** اعتبار السلوك مشتبه ماليًا وتحويل للتدقيق.
- **إجراء تلقائي:** Alert + Lock نوع `wallet_admin_lock`.
- **الأثر القابل للقياس:** خفض خسائر `wallet_abuse_loss`.

### 5) Verification Document Reuse Watch
- **سبب التفرد:** يكتشف إعادة استخدام مستندات تحقق عبر أكثر من حساب.
- **Trigger:** نفس `id_document_path` مرتبط بأكثر من مستخدم.
- **قرار إداري:** إيقاف مسارات التحقق المرتبطة لحين مراجعة أمنية.
- **إجراء تلقائي:** Alert + Lock نوع `verification_hold` للحسابات المتداخلة.
- **الأثر القابل للقياس:** خفض `synthetic_identity_rate`.

### 6) Pending Ride Rejection Sniping Monitor
- **سبب التفرد:** يلتقط إساءة رفض الطلبات من كابتن واحد بما يضر التخصيص.
- **Trigger:** تجاوز عدد رفضات محدد من نفس الكابتن في ساعة.
- **قرار إداري:** تخفيض أولوية الكابتن وتحويل لمراجعة تشغيلية.
- **إجراء تلقائي:** Alert + Lock نوع `dispatch_pause`.
- **الأثر القابل للقياس:** تحسين `pending_assignment_time`.

### 7) Incident Recurrence Heatmap Actioner
- **سبب التفرد:** يحوّل تكرار الحوادث إلى قرارات وقائية قابلة للتنفيذ.
- **Trigger:** تكرار Incidents من نفس الكابتن في نافذة زمنية قصيرة.
- **قرار إداري:** تفعيل Playbook وقائي حسب الشدة.
- **إجراء تلقائي:** Alert + Lock نوع `safety_watch` + توصية تصعيد.
- **الأثر القابل للقياس:** خفض `repeat_incident_rate`.

## التنفيذ المرحلي لكل ميزة
- **Pilot:** تفعيل افتراضي لمعظم الميزات مع thresholds محافظة.
- **Expand:** الميزات ذات الاستقرار الأعلى (مثل Wallet/Rejection).
- **General:** التعميم الكامل بعد تقييم metrics.

يتم ضبط المرحلة من داخل الواجهة لكل ميزة (`pilot` / `expand` / `general`).

## أماكن الظهور داخل لوحات الإدارة
- تمت إضافة شاشة جديدة: `admin-risk-command.html`.
- تمت إضافتها داخل قائمة الإدارة في `menu.html` باسم **Risk Command**.
- الدمج تم بأقل تغييرات في UX الحالي دون تعديل جوهري في الصفحات الأخرى.

## مواصفات API (تم التنفيذ)
- `GET /api/admin/risk/features`
- `PATCH /api/admin/risk/features/:key`
- `POST /api/admin/risk/scan`
- `GET /api/admin/risk/alerts`
- `POST /api/admin/risk/alerts/:id/decision`
- `GET /api/admin/risk/locks`
- `POST /api/admin/risk/locks/release`
- `GET /api/admin/risk/metrics`

## RBAC + Audit (تم التنفيذ)
- تمت إضافة صلاحيات:
	- `admin.risk.read`
	- `admin.risk.scan`
	- `admin.risk.decide`
	- `admin.risk.config`
- جميع عمليات الإنشاء/التعديل/القرار/فك القفل تُكتب في `admin_audit_logs` عبر `writeAdminAudit`.

## مصفوفة الأولوية النهائية
- **التأثير الأعلى/عائد أسرع:** Refund Burst Chain, Verification Reuse, Collusion Ring.
- **تكلفة منخفضة/عائد سريع:** Impossible Velocity, Wallet Churn.
- **تشغيلي عالي الأثر:** Rejection Sniping, Incident Recurrence.

## التحقق قبل الاعتماد التقني
- Endpoint smoke tests مضافة: `test-admin-risk-command.js`.
- مطلوب قبل أي اعتماد نهائي: تشغيل الاختبارات مع سيرفر شغال ثم نجاح التشغيل الكامل.

## شروط التحقق قبل أي اعتماد تقني
- اختبار كل Endpoint جديد قبل أي Commit.
- اختبار التشغيل/البناء قبل أي Commit.
- الالتزام بالـ Commit والـ Push على فرع `main` بعد نجاح الاختبارات.

## ملاحظة تنفيذية
هذه الوثيقة هي **اعتماد رسمي لخطة التوثيق والتطوير القادمة** لاقتراحات الإدارة الجديدة (الإصدار 3).
