# نظام أرباح السائقين - جدول driver_earnings

## نظرة عامة

تم إنشاء جدول `driver_earnings` لتتبع الأرباح اليومية لكل سائق بشكل منفصل ومنظم.

## بنية الجدول

```sql
CREATE TABLE driver_earnings (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    today_trips INTEGER DEFAULT 0,
    today_earnings NUMERIC(10,2) DEFAULT 0,
    total_trips INTEGER DEFAULT 0,
    total_earnings NUMERIC(10,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(driver_id, date)
);
```

### الأعمدة:

- **id**: المعرف الفريد للسجل
- **driver_id**: معرف السائق (مرتبط بجدول drivers)
- **date**: تاريخ السجل (سجل واحد لكل يوم لكل سائق)
- **today_trips**: عدد الرحلات المكتملة في هذا اليوم
- **today_earnings**: إجمالي الأرباح المكتسبة في هذا اليوم
- **total_trips**: إجمالي عدد الرحلات حتى هذا التاريخ
- **total_earnings**: إجمالي الأرباح حتى هذا التاريخ
- **created_at**: تاريخ إنشاء السجل
- **updated_at**: تاريخ آخر تحديث

## الفهارس

```sql
CREATE INDEX idx_driver_earnings_driver_date ON driver_earnings(driver_id, date);
CREATE INDEX idx_driver_earnings_date ON driver_earnings(date);
```

## API Endpoints

### 1. الحصول على إحصائيات السائق

```
GET /api/drivers/:id/stats
```

**الاستجابة:**
```json
{
  "success": true,
  "data": {
    "driver": {
      "id": 2,
      "name": "محمد علي",
      "phone": "0507654321",
      "email": "driver@example.com",
      "rating": 4.8
    },
    "earnings": {
      "total": 2500.50,
      "balance": 2500.50,
      "today": 350.75
    },
    "trips": {
      "total": 150,
      "today": 8,
      "completed": 150
    },
    "recent_trips": [...]
  }
}
```

### 2. الحصول على سجل الأرباح

```
GET /api/drivers/:id/earnings?days=30
```

**المعاملات:**
- `days`: عدد الأيام للبحث (افتراضي: 30)

**الاستجابة:**
```json
{
  "success": true,
  "data": [
    {
      "date": "2026-02-08",
      "today_trips": 8,
      "today_earnings": "350.75",
      "total_trips": 150,
      "total_earnings": "2500.50",
      "created_at": "2026-02-08T10:00:00.000Z",
      "updated_at": "2026-02-08T18:00:00.000Z"
    },
    {
      "date": "2026-02-07",
      "today_trips": 12,
      "today_earnings": "520.00",
      "total_trips": 142,
      "total_earnings": "2149.75",
      "created_at": "2026-02-07T09:00:00.000Z",
      "updated_at": "2026-02-07T21:00:00.000Z"
    }
  ]
}
```

## آلية العمل

### عند إكمال رحلة:

1. **تحديث جدول drivers:**
   - زيادة `total_earnings` و `balance` بقيمة الرحلة
   - زيادة `today_earnings` بقيمة الرحلة
   - زيادة `today_trips_count` و `total_trips` بمقدار 1

2. **تحديث جدول driver_earnings:**
   - إذا كان هناك سجل لليوم الحالي: تحديثه
   - إذا لم يكن هناك سجل: إنشاء سجل جديد
   - تحديث `today_trips` و `today_earnings`
   - حساب وتحديث `total_trips` و `total_earnings` من جدول trips

```javascript
// مثال على الكود في server.js
if (status === 'completed' && result.rows[0].driver_id && cost) {
    const driverId = result.rows[0].driver_id;
    const tripCost = parseFloat(cost);
    
    // تحديث جدول drivers
    await pool.query(`
        UPDATE drivers 
        SET total_earnings = COALESCE(total_earnings, 0) + $1,
            balance = COALESCE(balance, 0) + $1,
            today_earnings = COALESCE(today_earnings, 0) + $1,
            today_trips_count = COALESCE(today_trips_count, 0) + 1,
            total_trips = COALESCE(total_trips, 0) + 1
        WHERE id = $2
    `, [tripCost, driverId]);
    
    // تحديث أو إنشاء سجل في driver_earnings
    await pool.query(`
        INSERT INTO driver_earnings (driver_id, date, today_trips, today_earnings, total_trips, total_earnings)
        VALUES ($1, CURRENT_DATE, 1, $2, 1, $2)
        ON CONFLICT (driver_id, date) 
        DO UPDATE SET 
            today_trips = driver_earnings.today_trips + 1,
            today_earnings = driver_earnings.today_earnings + $2,
            updated_at = CURRENT_TIMESTAMP
    `, [driverId, tripCost]);
    
    // تحديث الإجماليات
    const totalResult = await pool.query(`
        SELECT COUNT(*) as total_trips, COALESCE(SUM(cost), 0) as total_earnings
        FROM trips
        WHERE driver_id = $1 AND status = 'completed'
    `, [driverId]);
    
    await pool.query(`
        UPDATE driver_earnings 
        SET total_trips = $1, total_earnings = $2
        WHERE driver_id = $3 AND date = CURRENT_DATE
    `, [
        parseInt(totalResult.rows[0].total_trips),
        parseFloat(totalResult.rows[0].total_earnings),
        driverId
    ]);
}
```

## المميزات

✅ **تتبع الأرباح اليومية**: سجل منفصل لكل يوم
✅ **حفظ التاريخ**: احتفاظ بسجل كامل للأرباح
✅ **إحصائيات دقيقة**: بيانات اليوم والإجمالي
✅ **أداء محسّن**: فهارس على التواريخ والسائقين
✅ **تكامل تلقائي**: تحديث تلقائي عند إكمال الرحلات

## الاستخدام في الواجهة

تستخدم صفحة [earnings.html](earnings.html) هذه البيانات لعرض:
- الرصيد الحالي
- أرباح اليوم
- عدد الرحلات (اليوم والإجمالي)
- سجل الرحلات الأخيرة

## ملاحظات

- القيد `UNIQUE(driver_id, date)` يضمن سجل واحد فقط لكل سائق في كل يوم
- استخدام `ON CONFLICT DO UPDATE` للتحديث التلقائي عند وجود سجل
- الأرباح محفوظة بدقة عشريتين (NUMERIC(10,2))
- التواريخ مخزنة بصيغة DATE (بدون الوقت)

## الاختبار

استخدم الملف `test-driver-earnings.js` لاختبار النظام:

```bash
node test-driver-earnings.js
```

سيقوم بـ:
1. الحصول على الإحصائيات الحالية
2. فحص جدول driver_earnings
3. إنشاء رحلة اختبارية
4. إكمال الرحلة
5. التحقق من تحديث البيانات في كل من جدول drivers وdriver_earnings
