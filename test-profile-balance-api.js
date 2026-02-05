// Test script for profile balance and points loading
// Node.js v18+ has built-in fetch

const BASE_URL = 'http://localhost:3000';

async function testProfileBalancePoints() {
    console.log('🧪 اختبار تحميل رصيد المحفظة ونقاط أكوادرا\n');
    console.log('='.repeat(50));

    try {
        // Test 1: Check if users table has balance and points columns
        console.log('\n1️⃣ اختبار وجود الأعمدة في قاعدة البيانات');
        const pool = require('./db');
        const columnsQuery = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users' 
            AND column_name IN ('balance', 'points')
            ORDER BY column_name
        `);
        console.log('   ✅ الأعمدة الموجودة:', columnsQuery.rows.map(r => r.column_name).join(', '));

        // Test 2: Get sample user data from database
        console.log('\n2️⃣ اختبار بيانات المستخدمين في قاعدة البيانات');
        const usersQuery = await pool.query(`
            SELECT id, name, balance, points 
            FROM users 
            WHERE balance > 0 OR points > 0
            LIMIT 3
        `);
        console.log('   عدد المستخدمين ذوي الرصيد/النقاط:', usersQuery.rows.length);
        usersQuery.rows.forEach(user => {
            console.log(`   - المستخدم ${user.id}: ${user.name}`);
            console.log(`     💰 الرصيد: ${user.balance} ر.س`);
            console.log(`     ⭐ النقاط: ${user.points}`);
        });

        // Test 3: Test API endpoint for users
        console.log('\n3️⃣ اختبار نقطة النهاية /api/users/:id');
        for (const user of usersQuery.rows) {
            const response = await fetch(`${BASE_URL}/api/users/${user.id}`);
            const data = await response.json();
            
            if (data.success) {
                console.log(`   ✅ المستخدم ${user.id}:`);
                console.log(`      الرصيد من API: ${data.data.balance} (قاعدة البيانات: ${user.balance})`);
                console.log(`      النقاط من API: ${data.data.points} (قاعدة البيانات: ${user.points})`);
                
                // Verify data matches
                if (parseFloat(data.data.balance) !== parseFloat(user.balance)) {
                    console.log(`      ⚠️ تحذير: الرصيد لا يتطابق!`);
                }
                if (parseInt(data.data.points) !== parseInt(user.points)) {
                    console.log(`      ⚠️ تحذير: النقاط لا تتطابق!`);
                }
            } else {
                console.log(`   ❌ فشل جلب بيانات المستخدم ${user.id}`);
            }
        }

        // Test 4: Test passengers endpoint (for users with role='passenger')
        console.log('\n4️⃣ اختبار نقطة النهاية /api/passengers/:id');
        const passengersQuery = await pool.query(`
            SELECT id, name, balance, points 
            FROM users 
            WHERE role = 'passenger' 
            AND (balance > 0 OR points > 0)
            LIMIT 2
        `);
        
        for (const passenger of passengersQuery.rows) {
            const response = await fetch(`${BASE_URL}/api/passengers/${passenger.id}`);
            const data = await response.json();
            
            if (data.success) {
                console.log(`   ✅ الراكب ${passenger.id}:`);
                console.log(`      الرصيد من API: ${data.data.balance} (قاعدة البيانات: ${passenger.balance})`);
                console.log(`      النقاط من API: ${data.data.points} (قاعدة البيانات: ${passenger.points})`);
            } else {
                console.log(`   ❌ فشل جلب بيانات الراكب ${passenger.id}`);
            }
        }

        // Test 5: Test update endpoint
        console.log('\n5️⃣ اختبار تحديث البيانات');
        const testUserId = usersQuery.rows[0].id;
        const originalBalance = parseFloat(usersQuery.rows[0].balance);
        const originalPoints = parseInt(usersQuery.rows[0].points);
        
        console.log(`   اختبار المستخدم ${testUserId}`);
        console.log(`   القيم الأصلية - الرصيد: ${originalBalance}، النقاط: ${originalPoints}`);
        
        // Update with +1 to balance and points
        const updateResponse = await fetch(`${BASE_URL}/api/users/${testUserId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                balance: originalBalance + 1,
                points: originalPoints + 1
            })
        });
        
        const updateData = await updateResponse.json();
        if (updateData.success) {
            console.log(`   ✅ تم التحديث - الرصيد الجديد: ${updateData.data.balance}، النقاط الجديدة: ${updateData.data.points}`);
            
            // Restore original values
            await fetch(`${BASE_URL}/api/users/${testUserId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    balance: originalBalance,
                    points: originalPoints
                })
            });
            console.log(`   ✅ تم استعادة القيم الأصلية`);
        } else {
            console.log(`   ❌ فشل التحديث:`, updateData.error);
        }

        console.log('\n' + '='.repeat(50));
        console.log('✅ اكتملت جميع الاختبارات بنجاح!\n');

    } catch (error) {
        console.error('\n❌ خطأ في الاختبار:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
    
    process.exit(0);
}

testProfileBalancePoints();
