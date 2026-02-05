const pool = require('./db');

async function testFullProfileUpdate() {
    try {
        console.log('🧪 اختبار شامل لتحديث الملف الشخصي من قاعدة البيانات...\n');
        console.log('='.repeat(60));

        // Step 1: Find the user from the screenshot
        console.log('\n📋 الخطوة 1: البحث عن المستخدم برقم الهاتف 930313653664...');
        const searchResult = await pool.query(
            `SELECT id, name, phone, email, balance, points, rating, status 
             FROM users 
             WHERE phone LIKE '%930313653664%' OR phone LIKE '%0930313653664%'`
        );

        let testUser;
        if (searchResult.rows.length === 0) {
            console.log('⚠️ لم يتم العثور على المستخدم، جاري إنشاء مستخدم جديد...');
            const createResult = await pool.query(
                `INSERT INTO users (phone, name, email, password, role, balance, points, rating, status) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
                 RETURNING *`,
                ['930313653664', 'راكب تجريبي', 'passenger3@ubar.sa', '123456', 'passenger', 0, 0, 5.0, 'عضو جديد']
            );
            testUser = createResult.rows[0];
            console.log('✅ تم إنشاء مستخدم جديد:', testUser.phone);
        } else {
            testUser = searchResult.rows[0];
            console.log('✅ تم العثور على المستخدم:', testUser.phone);
        }

        console.log('\n📊 البيانات الحالية في قاعدة البيانات:');
        console.log(`   ID: ${testUser.id}`);
        console.log(`   الاسم: ${testUser.name}`);
        console.log(`   الهاتف: ${testUser.phone}`);
        console.log(`   البريد: ${testUser.email}`);
        console.log(`   الرصيد: ${testUser.balance} ر.س`);
        console.log(`   النقاط: ${testUser.points}`);
        console.log(`   التقييم: ${testUser.rating} ⭐`);
        console.log(`   الحالة: ${testUser.status}`);

        // Step 2: Update with NEW values
        console.log('\n📋 الخطوة 2: تحديث البيانات في قاعدة البيانات بقيم جديدة...');
        const newBalance = 2500.75;
        const newPoints = 1234;
        const newRating = 4.85;
        const newStatus = '🌟 عضو بلاتيني';

        await pool.query(
            `UPDATE users 
             SET balance = $1, points = $2, rating = $3, status = $4 
             WHERE id = $5`,
            [newBalance, newPoints, newRating, newStatus, testUser.id]
        );

        console.log('✅ تم التحديث بنجاح!');
        console.log(`   ✏️ الرصيد الجديد: ${testUser.balance} → ${newBalance} ر.س`);
        console.log(`   ✏️ النقاط الجديدة: ${testUser.points} → ${newPoints}`);
        console.log(`   ✏️ التقييم الجديد: ${testUser.rating} → ${newRating} ⭐`);
        console.log(`   ✏️ الحالة الجديدة: ${testUser.status} → ${newStatus}`);

        // Step 3: Verify update in database
        console.log('\n📋 الخطوة 3: التحقق من التحديث في قاعدة البيانات...');
        const verifyResult = await pool.query(
            'SELECT id, name, phone, email, balance, points, rating, status FROM users WHERE id = $1',
            [testUser.id]
        );

        const updatedUser = verifyResult.rows[0];
        console.log('✅ البيانات المحدثة في قاعدة البيانات:');
        console.log(`   الرصيد: ${updatedUser.balance} ر.س`);
        console.log(`   النقاط: ${updatedUser.points}`);
        console.log(`   التقييم: ${updatedUser.rating} ⭐`);
        console.log(`   الحالة: ${updatedUser.status}`);

        // Step 4: Test API
        console.log('\n📋 الخطوة 4: اختبار API endpoint...');
        const apiResponse = await fetch(`http://localhost:3000/api/users/${testUser.id}`);
        const apiData = await apiResponse.json();
        
        if (apiData.success) {
            console.log('✅ API يعيد البيانات المحدثة:');
            console.log(`   الرصيد: ${apiData.data.balance} ر.س`);
            console.log(`   النقاط: ${apiData.data.points}`);
            console.log(`   التقييم: ${apiData.data.rating} ⭐`);
            console.log(`   الحالة: ${apiData.data.status}`);
            
            // Verify the values match
            if (apiData.data.balance == newBalance && 
                apiData.data.points == newPoints && 
                apiData.data.rating == newRating) {
                console.log('\n✅✅✅ API يعيد القيم الصحيحة المحدثة!');
            } else {
                console.log('\n❌ تحذير: القيم من API لا تطابق البيانات المحدثة');
            }
        } else {
            console.log('❌ فشل في جلب البيانات من API');
        }

        console.log('\n' + '='.repeat(60));
        console.log('✅✅✅ اكتمل الاختبار الشامل بنجاح!');
        console.log('='.repeat(60));
        
        console.log('\n📱 الآن اتبع الخطوات التالية لاختبار صفحة الملف الشخصي:\n');
        console.log('1️⃣  افتح المتصفح على: http://localhost:3000/profile.html');
        console.log(`2️⃣  سجل الدخول برقم الهاتف: ${updatedUser.phone}`);
        console.log('3️⃣  يجب أن تظهر البيانات التالية:');
        console.log(`     💰 رصيد المحفظة: ${updatedUser.balance} ر.س`);
        console.log(`     🎁 النقاط: ${updatedUser.points}`);
        console.log(`     ⭐ التقييم: ${updatedUser.rating}`);
        console.log(`     👤 الحالة: ${updatedUser.status}`);
        console.log('\n4️⃣  إذا لم تظهر القيم المحدثة:');
        console.log('     - اضغط على زر "تحديث" 🔄');
        console.log('     - أو سجل خروج ثم سجل دخول مرة أخرى');
        console.log('     - أو اضغط F5 لتحديث الصفحة');
        console.log('\n5️⃣  حاول الضغط على "تعديل" - يجب أن تكون الحقول التالية غير قابلة للتعديل 🔒:');
        console.log('     - رصيد المحفظة');
        console.log('     - النقاط');
        console.log('     - التقييم');
        console.log('     - حالة العضوية');

    } catch (error) {
        console.error('❌ خطأ في الاختبار:', error);
    } finally {
        await pool.end();
    }
}

testFullProfileUpdate();
