const API_BASE_URL = 'http://localhost:3000/api';

async function testDirectDatabaseUpdate() {
    console.log('🧪 اختبار التحديث المباشر من قاعدة البيانات\n');

    try {
        // Step 1: Get a passenger
        console.log('1️⃣ جلب راكب...');
        let response = await fetch(`${API_BASE_URL}/passengers?limit=1`);
        let data = await response.json();
        
        if (!data.success || data.data.length === 0) {
            throw new Error('لا يوجد ركاب في النظام');
        }
        
        const passenger = data.data[0];
        console.log(`✅ تم جلب الراكب: ${passenger.name} (ID: ${passenger.id})`);
        console.log('   📊 البيانات الحالية:');
        console.log(`      - التقييم: ${passenger.rating || 5.0}`);
        console.log(`      - نقاط أكوادرا: ${passenger.points || 0}`);
        console.log(`      - رصيد المحفظة: ${passenger.balance || 0} ريال`);

        // Step 2: Simulate direct database update
        console.log('\n2️⃣ محاكاة تحديث مباشر في قاعدة البيانات...');
        const newRating = 3.7;
        const newPoints = 999;
        const newBalance = 1500.25;
        const newStatus = '💎 عضو بلاتيني';

        response = await fetch(`${API_BASE_URL}/passengers/${passenger.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: passenger.name,
                phone: passenger.phone,
                email: passenger.email,
                rating: newRating,
                points: newPoints,
                balance: newBalance,
                status: newStatus
            })
        });

        data = await response.json();
        
        if (!data.success) {
            throw new Error(`فشل التحديث: ${data.error}`);
        }

        console.log('✅ تم التحديث في قاعدة البيانات:');
        console.log(`   - التقييم: ${data.data.rating}`);
        console.log(`   - نقاط أكوادرا: ${data.data.points}`);
        console.log(`   - رصيد المحفظة: ${data.data.balance} ريال`);
        console.log(`   - الحالة: ${data.data.status}`);

        // Step 3: Fetch again to verify
        console.log('\n3️⃣ إعادة جلب البيانات للتحقق...');
        response = await fetch(`${API_BASE_URL}/passengers/${passenger.id}`);
        data = await response.json();

        if (!data.success) {
            throw new Error('فشل جلب البيانات');
        }

        const verified = data.data;
        console.log('✅ البيانات المحفوظة في قاعدة البيانات:');
        console.log(`   - التقييم: ${verified.rating}`);
        console.log(`   - نقاط أكوادرا: ${verified.points}`);
        console.log(`   - رصيد المحفظة: ${verified.balance} ريال`);
        console.log(`   - الحالة: ${verified.status}`);

        // Step 4: Verify values match
        console.log('\n4️⃣ التحقق من البيانات...');
        const ratingMatch = parseFloat(verified.rating) === newRating;
        const pointsMatch = parseInt(verified.points) === newPoints;
        const balanceMatch = parseFloat(verified.balance) === newBalance;
        const statusMatch = verified.status === newStatus;

        console.log(`   ${ratingMatch ? '✅' : '❌'} التقييم ${ratingMatch ? 'صحيح' : 'خاطئ'}`);
        console.log(`   ${pointsMatch ? '✅' : '❌'} نقاط أكوادرا ${pointsMatch ? 'صحيحة' : 'خاطئة'}`);
        console.log(`   ${balanceMatch ? '✅' : '❌'} رصيد المحفظة ${balanceMatch ? 'صحيح' : 'خاطئ'}`);
        console.log(`   ${statusMatch ? '✅' : '❌'} الحالة ${statusMatch ? 'صحيحة' : 'خاطئة'}`);

        if (ratingMatch && pointsMatch && balanceMatch && statusMatch) {
            console.log('\n🎉 الاختبار نجح! التحديثات من قاعدة البيانات محفوظة وتعمل بشكل صحيح');
            console.log('\n📱 الآن قم بالخطوات التالية:');
            console.log(`   1. افتح صفحة الملف الشخصي لهذا الراكب (ID: ${passenger.id})`);
            console.log(`   2. تأكد من ظهور البيانات التالية:`);
            console.log(`      - التقييم: ${newRating}`);
            console.log(`      - نقاط أكوادرا: ${newPoints}`);
            console.log(`      - رصيد المحفظة: ${newBalance} ريال`);
            console.log(`      - الحالة: ${newStatus}`);
            console.log(`   3. إذا ظهرت البيانات بشكل صحيح، فالمشكلة تم حلها! ✅`);
        } else {
            console.log('\n⚠️ بعض البيانات لا تتطابق');
        }

    } catch (error) {
        console.error('❌ خطأ في الاختبار:', error.message);
        process.exit(1);
    }
}

// Run the test
testDirectDatabaseUpdate()
    .then(() => {
        console.log('\n✅ اكتمل الاختبار');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ فشل الاختبار:', err);
        process.exit(1);
    });
