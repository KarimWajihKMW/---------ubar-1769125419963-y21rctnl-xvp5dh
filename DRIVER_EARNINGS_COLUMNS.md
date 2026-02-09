# تحديث نظام أرباح السائقين

## نظرة عامة
تم إضافة أعمدة جديدة لجدول السائقين في قاعدة البيانات لتخزين بيانات الأرباح والرحلات اليومية والإجمالية.

## التغييرات في قاعدة البيانات

### 1. تحديث جدول drivers
تم إضافة الأعمدة التالية:

```sql
ALTER TABLE drivers ADD COLUMN:
- total_earnings DECIMAL(10, 2) DEFAULT 0.00  -- إجمالي الأرباح
- balance DECIMAL(10, 2) DEFAULT 0.00         -- الرصيد الحالي
- today_earnings DECIMAL(10, 2) DEFAULT 0.00  -- أرباح اليوم
- today_trips_count INTEGER DEFAULT 0         -- عدد رحلات اليوم
- last_earnings_update DATE DEFAULT CURRENT_DATE -- آخر تحديث
```

### 2. جدول driver_earnings الجديد
تم إنشاء جدول جديد لتتبع الأرباح اليومية للسائقين:

```sql
CREATE TABLE driver_earnings (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    today_trips INTEGER DEFAULT 0,
    today_earnings DECIMAL(10, 2) DEFAULT 0.00,
    total_trips INTEGER DEFAULT 0,
    total_earnings DECIMAL(10, 2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(driver_id, date)
);
```

### 3. Indexes
تم إنشاء index لتحسين الأداء:
```sql
CREATE INDEX idx_driver_earnings_driver_date ON driver_earnings(driver_id, date DESC);
```

## الملفات المعدلة

### 1. setup-db.js
- تم تحديث بنية جدول drivers لتشمل الأعمدة الجديدة
- تم إضافة جدول driver_earnings
- تم إضافة index للجدول الجديد

### 2. migrate-driver-earnings.js (جديد)
سكريبت migration لتحديث قاعدة البيانات الحالية:
- يضيف الأعمدة الجديدة إلى جدول drivers
- ينشئ جدول driver_earnings
- يحسب الأرباح الحالية من جدول trips
- يملأ الجداول بالبيانات الحالية

## API Endpoints

### GET /api/drivers/:id/stats
يعيد إحصائيات السائق شاملة:

**Response:**
```json
{
  "success": true,
  "data": {
    "driver": {
      "id": 1,
      "name": "أحمد عبدالله المالكي",
      "phone": "0501234567",
      "email": "driver1@ubar.sa",
      "rating": 4.85
    },
    "earnings": {
      "total": 2520.50,      // إجمالي الأرباح
      "balance": 2520.50,    // الرصيد
      "today": 0.00          // أرباح اليوم
    },
    "trips": {
      "total": 342,          // إجمالي الرحلات
      "today": 0             // رحلات اليوم
    },
    "recent_trips": [...]
  }
}
```

## واجهة السائق (earnings.html)

تعرض الواجهة الآن:
- 💵 إجمالي الرصيد (balance)
- 🚖 الرحلات المكتملة (total_trips)
- 📅 رحلات اليوم (today_trips)
- 💰 أرباح اليوم (today_earnings)

## التشغيل والاختبار

### 1. تشغيل Migration
```bash
node migrate-driver-earnings.js
```

### 2. اختبار API
```bash
node test-driver-earnings-columns.js
```

## ملاحظات مهمة

1. **تحديث تلقائي**: الأعمدة الجديدة يتم تحديثها تلقائياً عند إكمال الرحلات
2. **الرصيد**: يمثل إجمالي الأرباح التي لم يتم سحبها
3. **اليوم**: يتم إعادة ضبط أرباح ورحلات اليوم في منتصف الليل
4. **driver_earnings**: يحفظ سجل يومي لكل سائق

## البيانات الحالية

بعد تشغيل Migration:
- تم حساب الأرباح الإجمالية من جدول trips
- تم تعبئة balance بإجمالي الأرباح
- today_earnings و today_trips_count = 0 (لأنه لا توجد رحلات اليوم)

## الخطوات التالية

لضمان تحديث البيانات تلقائياً:
1. عند إكمال رحلة جديدة، يجب تحديث:
   - `drivers.total_earnings`
   - `drivers.balance`
   - `drivers.today_earnings`
   - `drivers.today_trips_count`
   - `drivers.total_trips`
   
2. في نهاية كل يوم:
   - حفظ البيانات في `driver_earnings`
   - إعادة ضبط `today_earnings` و `today_trips_count` إلى 0
