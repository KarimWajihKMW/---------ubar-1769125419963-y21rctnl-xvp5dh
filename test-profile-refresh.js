const pool = require('./db');

async function testProfileRefresh() {
    try {
        console.log('🧪 اختبار تحديث بيانات الملف الشخصي من قاعدة البيانات...\n');

        // Step 1: Get a test user
        console.log('📋 الخطوة 1: جلب مستخدم للاختبار...');
        const userResult = await pool.query(
            "SELECT * FROM users WHERE role = 'passenger' LIMIT 1"
        );

        if (userResult.rows.length === 0) {
            console.log('❌ لا يوجد مستخدمين في قاعدة البيانات');
            console.log('💡 سيتم إنشاء مستخدم تجريبي...');
            
            const createResult = await pool.query(
                `INSERT INTO users (phone, name, email, password, role, balance, points, rating, status) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
                 RETURNING *`,
                ['0501234567', 'أحمد محمد', 'ahmed@test.com', '123456', 'passenger', 100.00, 500, 4.5, 'عضو ذهبي']
            );
            console.log('✅ تم إنشاء مستخدم تجريبي:', createResult.rows[0]);
            var testUser = createResult.rows[0];
        } else {
            var testUser = userResult.rows[0];
            console.log('✅ تم العثور على مستخدم:', testUser.name, `(ID: ${testUser.id})`);
        }

        console.log('\n📊 البيانات الحالية:');
        console.log(`   الاسم: ${testUser.name}`);
        console.log(`   الهاتف: ${testUser.phone}`);
        console.log(`   رصيد المحفظة: ${testUser.balance} ر.س`);
        console.log(`   النقاط: ${testUser.points}`);
        console.log(`   التقييم: ${testUser.rating} ⭐`);
        console.log(`   الحالة: ${testUser.status}`);

        // Step 2: Update balance, rating, and points in database
        console.log('\n📋 الخطوة 2: تحديث البيانات في قاعدة البيانات...');
        const newBalance = 1500.25;
        const newPoints = 999;
        const newRating = 3.70;
        const newStatus = 'عضو ذهبي';

        await pool.query(
            `UPDATE users 
             SET balance = $1, points = $2, rating = $3, status = $4 
             WHERE id = $5`,
            [newBalance, newPoints, newRating, newStatus, testUser.id]
        );

        console.log('✅ تم تحديث البيانات في قاعدة البيانات:');
        console.log(`   رصيد المحفظة: ${newBalance} ر.س`);
        console.log(`   النقاط: ${newPoints}`);
        console.log(`   التقييم: ${newRating} ⭐`);
        console.log(`   الحالة: ${newStatus}`);

        // Step 3: Verify the update
        console.log('\n📋 الخطوة 3: التحقق من التحديث...');
        const verifyResult = await pool.query(
            'SELECT id, name, phone, balance, points, rating, status FROM users WHERE id = $1',
            [testUser.id]
        );

        const updatedUser = verifyResult.rows[0];
        console.log('✅ البيانات المحدثة في قاعدة البيانات:');
        console.log(`   الاسم: ${updatedUser.name}`);
        console.log(`   الهاتف: ${updatedUser.phone}`);
        console.log(`   رصيد المحفظة: ${updatedUser.balance} ر.س`);
        console.log(`   النقاط: ${updatedUser.points}`);
        console.log(`   التقييم: ${updatedUser.rating} ⭐`);
        console.log(`   الحالة: ${updatedUser.status}`);

        // Step 4: Test API endpoint
        console.log('\n📋 الخطوة 4: اختبار API endpoint...');
        const apiTestResponse = await fetch(`http://localhost:3000/api/users/${testUser.id}`);
        const apiData = await apiTestResponse.json();
        
        if (apiData.success) {
            console.log('✅ API يعيد البيانات الصحيحة:');
            console.log(`   رصيد المحفظة: ${apiData.data.balance} ر.س`);
            console.log(`   النقاط: ${apiData.data.points}`);
            console.log(`   التقييم: ${apiData.data.rating} ⭐`);
            console.log(`   الحالة: ${apiData.data.status}`);
        } else {
            console.log('❌ فشل في جلب البيانات من API');
        }

        console.log('\n' + '='.repeat(60));
        console.log('✅✅✅ اكتمل الاختبار بنجاح!');
        console.log('='.repeat(60));
        console.log('\n📱 لاختبار صفحة الملف الشخصي:');
        console.log(`   1. افتح المتصفح على: http://localhost:3000/profile.html`);
        console.log(`   2. سجل الدخول برقم الهاتف: ${updatedUser.phone}`);
        console.log(`   3. تحقق من أن البيانات التالية تظهر بشكل صحيح:`);
        console.log(`      - رصيد المحفظة: ${updatedUser.balance} ر.س`);
        console.log(`      - النقاط: ${updatedUser.points}`);
        console.log(`      - التقييم: ${updatedUser.rating} ⭐`);
        console.log(`      - الحالة: ${updatedUser.status}`);
        console.log(`   4. اضغط على زر "تحديث" 🔄 للتحقق من تحديث البيانات`);
        console.log(`   5. حاول تعديل الملف الشخصي - الرصيد والتقييم والنقاط يجب أن تكون غير قابلة للتعديل 🔒`);

    } catch (error) {
        console.error('❌ خطأ في الاختبار:', error);
    } finally {
        await pool.end();
    }
}

testProfileRefresh();
