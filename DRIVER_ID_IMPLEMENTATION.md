# Driver ID Implementation في جدول Users

## التغييرات المنفذة

### 1. إضافة عمود driver_id
تم إضافة عمود `driver_id` إلى جدول `users` لربط السائقين بمعرف فريد.

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_id INTEGER;
```

### 2. تحديث السجلات الموجودة
تم تحديث جميع السائقين الموجودين بحيث `driver_id = id` للسائقين فقط:

```sql
UPDATE users SET driver_id = id WHERE role = 'driver';
```

**النتائج:**
- 5 سائقين تم تحديثهم
- الركاب يحتفظون بـ `driver_id = NULL`

### 3. إنشاء Index للأداء
تم إنشاء index على عمود `driver_id` لتحسين الأداء:

```sql
CREATE INDEX IF NOT EXISTS idx_users_driver_id ON users(driver_id);
```

## هيكل جدول Users الحالي

| العمود | النوع | الوصف |
|--------|------|-------|
| id | INTEGER | المعرف الأساسي |
| phone | VARCHAR | رقم الهاتف |
| name | VARCHAR | الاسم |
| email | VARCHAR | البريد الإلكتروني |
| password | VARCHAR | كلمة المرور |
| role | VARCHAR | الدور (driver/passenger) |
| driver_id | INTEGER | معرف السائق (للسائقين فقط) |
| balance | NUMERIC | الرصيد |
| points | INTEGER | النقاط |
| rating | NUMERIC | التقييم |
| ... | ... | ... |

## الاستخدام

### الحصول على معلومات سائق محدد
```javascript
const driver = await pool.query(
  'SELECT * FROM users WHERE driver_id = $1',
  [driverId]
);
```

### الحصول على جميع السائقين
```javascript
const drivers = await pool.query(
  'SELECT * FROM users WHERE role = \'driver\' AND driver_id IS NOT NULL'
);
```

### ربط مع جدول driver_earnings
```javascript
const driverWithEarnings = await pool.query(`
  SELECT u.*, de.today_earnings, de.total_earnings
  FROM users u
  LEFT JOIN driver_earnings de ON u.driver_id = de.driver_id
  WHERE u.driver_id = $1
`, [driverId]);
```

## الاختبارات

تم إنشاء ملف `test-driver-id.js` للتحقق من:
1. ✅ وجود عمود driver_id
2. ✅ جميع السائقين لديهم driver_id
3. ✅ الركاب لديهم driver_id = NULL
4. ✅ وجود index على driver_id
5. ✅ عمل الاستعلامات بشكل صحيح

### تشغيل الاختبارات
```bash
node test-driver-id.js
```

## ملاحظات مهمة

1. **للسائقين الجدد**: عند تسجيل سائق جديد، يجب تعيين `driver_id = id` تلقائياً
2. **للركاب**: يبقى `driver_id = NULL`
3. **الربط مع جداول أخرى**: يمكن استخدام `driver_id` للربط مع جدول `driver_earnings`

## التحديثات المستقبلية المقترحة

1. إضافة trigger لتعيين driver_id تلقائياً عند إنشاء سائق جديد:
```sql
CREATE OR REPLACE FUNCTION set_driver_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'driver' THEN
    NEW.driver_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auto_set_driver_id
  BEFORE INSERT ON users
  FOR EACH ROW
  WHEN (NEW.role = 'driver')
  EXECUTE FUNCTION set_driver_id();
```

2. إضافة constraint لضمان أن driver_id فريد:
```sql
ALTER TABLE users ADD CONSTRAINT unique_driver_id 
  UNIQUE (driver_id) WHERE driver_id IS NOT NULL;
```

## التاريخ
- **تاريخ التنفيذ**: 8 فبراير 2026
- **المطور**: GitHub Copilot
- **الحالة**: ✅ مكتمل ومختبر
