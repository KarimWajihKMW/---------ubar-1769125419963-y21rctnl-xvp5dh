#!/bin/bash
# Comprehensive test for profile balance and points feature

echo "🧪 اختبار شامل لميزة رصيد المحفظة ونقاط أكوادرا"
echo "========================================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Function to run test
run_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_output="$3"
    
    echo -n "📋 $test_name: "
    
    result=$(eval "$test_command" 2>&1)
    
    if echo "$result" | grep -q "$expected_output"; then
        echo -e "${GREEN}✅ نجح${NC}"
        ((TESTS_PASSED++))
        return 0
    else
        echo -e "${RED}❌ فشل${NC}"
        echo "   المخرج: $result"
        ((TESTS_FAILED++))
        return 1
    fi
}

echo "1️⃣ اختبار قاعدة البيانات"
echo "-------------------------"

# Test database connection
run_test "الاتصال بقاعدة البيانات" \
    "node -e \"const pool = require('./db'); pool.query('SELECT 1').then(() => { console.log('OK'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });\"" \
    "OK"

# Test balance column exists
run_test "وجود عمود الرصيد" \
    "node -e \"const pool = require('./db'); pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = \\'users\\' AND column_name = \\'balance\\'').then(r => { console.log(r.rows.length > 0 ? 'YES' : 'NO'); process.exit(0); });\"" \
    "YES"

# Test points column exists
run_test "وجود عمود النقاط" \
    "node -e \"const pool = require('./db'); pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = \\'users\\' AND column_name = \\'points\\'').then(r => { console.log(r.rows.length > 0 ? 'YES' : 'NO'); process.exit(0); });\"" \
    "YES"

echo ""
echo "2️⃣ اختبار API Endpoints"
echo "-------------------------"

# Check if server is running
if ! lsof -i :3000 -sTCP:LISTEN > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  الخادم غير مشغل على المنفذ 3000${NC}"
    echo "   قم بتشغيل الخادم أولاً: node server.js"
    exit 1
fi

# Test GET /api/users/:id endpoint
run_test "جلب بيانات المستخدم (GET /api/users/3)" \
    "curl -s http://localhost:3000/api/users/3" \
    "\"balance\""

run_test "التحقق من وجود النقاط في الاستجابة" \
    "curl -s http://localhost:3000/api/users/3" \
    "\"points\""

run_test "التحقق من نجاح الطلب" \
    "curl -s http://localhost:3000/api/users/3 | jq -r '.success'" \
    "true"

# Test GET /api/passengers/:id endpoint
run_test "جلب بيانات الراكب (GET /api/passengers/3)" \
    "curl -s http://localhost:3000/api/passengers/3" \
    "\"balance\""

echo ""
echo "3️⃣ اختبار قيم البيانات"
echo "-------------------------"

# Get user 3 balance
USER_3_BALANCE=$(curl -s http://localhost:3000/api/users/3 | jq -r '.data.balance')
USER_3_POINTS=$(curl -s http://localhost:3000/api/users/3 | jq -r '.data.points')

echo "   المستخدم 3:"
echo "   💰 الرصيد: $USER_3_BALANCE ر.س"
echo "   ⭐ النقاط: $USER_3_POINTS"

if [ "$USER_3_BALANCE" != "null" ] && [ "$USER_3_BALANCE" != "" ]; then
    echo -e "   ${GREEN}✅ الرصيد موجود${NC}"
    ((TESTS_PASSED++))
else
    echo -e "   ${RED}❌ الرصيد غير موجود${NC}"
    ((TESTS_FAILED++))
fi

if [ "$USER_3_POINTS" != "null" ] && [ "$USER_3_POINTS" != "" ]; then
    echo -e "   ${GREEN}✅ النقاط موجودة${NC}"
    ((TESTS_PASSED++))
else
    echo -e "   ${RED}❌ النقاط غير موجودة${NC}"
    ((TESTS_FAILED++))
fi

echo ""
echo "4️⃣ اختبار ملفات الصفحات"
echo "-------------------------"

# Test profile.html exists
run_test "وجود ملف profile.html" \
    "[ -f profile.html ] && echo YES || echo NO" \
    "YES"

# Test profile.html is served
run_test "إمكانية الوصول لـ profile.html" \
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/profile.html" \
    "200"

# Test profile.html contains balance field
run_test "وجود حقل الرصيد في profile.html" \
    "curl -s http://localhost:3000/profile.html | grep 'data-field=\"balance\"' > /dev/null && echo YES || echo NO" \
    "YES"

# Test profile.html contains points field  
run_test "وجود حقل النقاط في profile.html" \
    "curl -s http://localhost:3000/profile.html | grep 'data-field=\"points\"' > /dev/null && echo YES || echo NO" \
    "YES"

# Test api-service.js contains getById method
run_test "وجود دالة getById في api-service.js" \
    "grep 'getById(id)' api-service.js > /dev/null && echo YES || echo NO" \
    "YES"

echo ""
echo "========================================================"
echo "📊 ملخص النتائج"
echo "========================================================"
echo -e "   ${GREEN}✅ اختبارات ناجحة: $TESTS_PASSED${NC}"
echo -e "   ${RED}❌ اختبارات فاشلة: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 نجحت جميع الاختبارات!${NC}"
    echo ""
    echo "✅ رصيد المحفظة ونقاط أكوادرا مربوطة بقاعدة البيانات بشكل صحيح"
    echo ""
    echo "🌐 صفحات الاختبار المتاحة:"
    echo "   - http://localhost:3000/test-profile-balance.html"
    echo "   - http://localhost:3000/test-profile-login.html"
    echo "   - http://localhost:3000/test-profile-full.html"
    echo "   - http://localhost:3000/profile.html"
    exit 0
else
    echo -e "${RED}⚠️  بعض الاختبارات فشلت. يرجى مراجعة المخرجات أعلاه.${NC}"
    exit 1
fi
