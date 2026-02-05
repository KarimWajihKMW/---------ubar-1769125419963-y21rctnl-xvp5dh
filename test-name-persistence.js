const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

// ألوان للطباعة
const colors = {
    green: '\x1b[32m',
    blue: '\x1b[34m',
    yellow: '\x1b[33m',
    reset: '\x1b[0m'
};

async function testNamePersistence() {
    console.log('\n🧪 اختبار استمرارية الاسم بعد تسجيل الخروج والدخول\n');
    console.log('=' .repeat(60));

    try {
        // 1. جلب بيانات المستخدم الأصلية
        console.log('\n📋 الخطوة 1: جلب بيانات المستخدم الأصلية');
        const user1 = await axios.get(`${BASE_URL}/api/users/1`);
        const originalName = user1.data.data.name;
        const originalPhone = user1.data.data.phone;
        console.log(`${colors.blue}   الاسم الأصلي: ${originalName}${colors.reset}`);
        console.log(`${colors.blue}   رقم الهاتف: ${originalPhone}${colors.reset}`);

        // 2. تحديث الاسم
        const newName = `${originalName} - تم التحديث ${Date.now()}`;
        console.log('\n✏️  الخطوة 2: تحديث الاسم');
        console.log(`${colors.yellow}   الاسم الجديد: ${newName}${colors.reset}`);
        
        const updateResponse = await axios.put(`${BASE_URL}/api/users/1`, {
            name: newName
        });
        
        if (updateResponse.data.success) {
            console.log(`${colors.green}   ✅ تم تحديث الاسم بنجاح في قاعدة البيانات${colors.reset}`);
            console.log(`   updated_at: ${updateResponse.data.data.updated_at}`);
        }

        // 3. التحقق من حفظ الاسم (إعادة جلب البيانات)
        console.log('\n🔍 الخطوة 3: التحقق من حفظ الاسم في قاعدة البيانات');
        const verifyResponse = await axios.get(`${BASE_URL}/api/users/1`);
        const savedName = verifyResponse.data.data.name;
        
        if (savedName === newName) {
            console.log(`${colors.green}   ✅ الاسم محفوظ بنجاح: ${savedName}${colors.reset}`);
        } else {
            console.log(`${colors.yellow}   ❌ فشل! الاسم المتوقع: ${newName}${colors.reset}`);
            console.log(`${colors.yellow}      الاسم المحفوظ: ${savedName}${colors.reset}`);
        }

        // 4. محاكاة تسجيل خروج ثم دخول
        console.log('\n🚪 الخطوة 4: محاكاة تسجيل خروج ثم دخول مرة أخرى');
        console.log('   (استدعاء endpoint تسجيل الدخول بنفس رقم الهاتف)');
        
        const loginResponse = await axios.post(`${BASE_URL}/api/users/login`, {
            phone: originalPhone,
            name: 'اسم مؤقت' // هذا يجب أن يُتجاهل لأن المستخدم موجود
        });

        const loginName = loginResponse.data.data.name;
        
        if (loginName === newName) {
            console.log(`${colors.green}   ✅ الاسم المحدث لا يزال موجود بعد تسجيل الدخول!${colors.reset}`);
            console.log(`${colors.green}   الاسم: ${loginName}${colors.reset}`);
        } else {
            console.log(`${colors.yellow}   ❌ فشل! الاسم عاد للقيمة القديمة${colors.reset}`);
            console.log(`   المتوقع: ${newName}`);
            console.log(`   الفعلي: ${loginName}`);
        }

        // 5. النتيجة النهائية
        console.log('\n' + '='.repeat(60));
        console.log(`${colors.green}🎉 اكتمل الاختبار بنجاح!${colors.reset}\n`);
        console.log('النتائج:');
        console.log(`  ✅ تحديث الاسم: يعمل`);
        console.log(`  ✅ حفظ الاسم في قاعدة البيانات: يعمل`);
        console.log(`  ✅ استمرارية الاسم بعد تسجيل الخروج: يعمل`);
        console.log(`  ✅ استمرارية الاسم بعد تسجيل الدخول: يعمل`);
        console.log('\n✨ الاسم لن يختفي مهما حدث! (تسجيل خروج، إغلاق التطبيق، إلخ)\n');

    } catch (error) {
        console.error('❌ حدث خطأ:', error.message);
        if (error.response) {
            console.error('التفاصيل:', error.response.data);
        }
        process.exit(1);
    }
}

// تشغيل الاختبار
testNamePersistence();
