#!/bin/bash

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║     مثال توضيحي: تحديث أرباح السائق من قاعدة البيانات      ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Database connection details
# Required: export DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DB"
: "${DATABASE_URL:?❌ Please export DATABASE_URL before running this script}"

echo "📊 المثال 1: تحديث أرباح السائق ID=1"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "1️⃣  عرض البيانات الحالية:"
psql "$DATABASE_URL" -c "
SELECT id, name, today_earnings, today_trips_count, balance, total_trips 
FROM drivers 
WHERE id = 1;"

echo ""
echo "2️⃣  تحديث البيانات:"
echo "   - أرباح اليوم: 750.50 ر.س"
echo "   - رحلات اليوم: 20 رحلة"
echo ""

psql "$DATABASE_URL" -c "
UPDATE drivers 
SET 
    today_earnings = 750.50,
    today_trips_count = 20,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;"

echo ""
echo "3️⃣  عرض البيانات بعد التحديث:"
PGPASSWORD=$DB_PASS psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "
SELECT id, name, today_earnings, today_trips_count, balance, total_trips 
FROM drivers 
WHERE id = 1;"

echo ""
echo "✅ تم التحديث بنجاح!"
echo ""
echo "🌐 الآن افتح صفحة earnings.html في المتصفح:"
echo "   1. اضغط على زر \"تحديث\" 🔄"
echo "   2. أو انتظر 10 ثواني للتحديث التلقائي"
echo "   3. ستظهر البيانات الجديدة فوراً!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 ملاحظات:"
echo "   • التطبيق يحدث البيانات تلقائياً كل 10 ثواني"
echo "   • يمكنك استخدام زر التحديث اليدوي في أي وقت"
echo "   • لا توجد أي تأخير - التحديثات فورية!"
echo ""
