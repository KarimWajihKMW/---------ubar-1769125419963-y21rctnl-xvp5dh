const API_BASE_URL = 'http://localhost:3000/api';

async function testPassengerUpdate() {
    console.log('🧪 اختبار تحديث بيانات الراكب\n');

    try {
        // Step 1: Get a passenger
        console.log('1️⃣ جلب قائمة الركاب...');
        let response = await fetch(`${API_BASE_URL}/passengers?limit=1`);
        let data = await response.json();
        
        if (!data.success || data.data.length === 0) {
            console.log('⚠️ لا يوجد ركاب في النظام، سيتم إنشاء راكب جديد');
            
            // Create a test passenger
            response = await fetch(`${API_BASE_URL}/users/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone: '01234567890',
                    name: 'راكب تجريبي',
                    email: 'test-passenger@ubar.sa'
                })
            });
            
            data = await response.json();
            if (!data.success) {
                throw new Error('فشل إنشاء راكب تجريبي');
            }
        }
        
        const passenger = data.data.length ? data.data[0] : data.data;
        console.log(`✅ تم جلب الراكب: ${passenger.name} (ID: ${passenger.id})`);
        console.log('   📊 البيانات الحالية:');
        console.log(`      - التقييم: ${passenger.rating || 5.0}`);
        console.log(`      - نقاط أكوادرا: ${passenger.points || 0}`);
        console.log(`      - رصيد المحفظة: ${passenger.balance || 0} ريال`);
        console.log(`      - الحالة: ${passenger.status || 'عضو جديد'}`);

        // Step 2: Update passenger data
        console.log('\n2️⃣ تحديث بيانات الراكب...');
        const updateData = {
            name: passenger.name,
            phone: passenger.phone,
            email: passenger.email,
            rating: 4.8,
            points: 150,
            balance: 500.50,
            status: '👑 عضو ذهبي',
            avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=test'
        };

        response = await fetch(`${API_BASE_URL}/passengers/${passenger.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateData)
        });

        data = await response.json();
        
        if (!data.success) {
            throw new Error(`فشل التحديث: ${data.error}`);
        }

        console.log('✅ تم تحديث البيانات بنجاح');
        console.log('   📊 البيانات الجديدة:');
        console.log(`      - التقييم: ${data.data.rating}`);
        console.log(`      - نقاط أكوادرا: ${data.data.points}`);
        console.log(`      - رصيد المحفظة: ${data.data.balance} ريال`);
        console.log(`      - الحالة: ${data.data.status}`);

        // Step 3: Verify by fetching again
        console.log('\n3️⃣ التحقق من حفظ البيانات...');
        response = await fetch(`${API_BASE_URL}/passengers/${passenger.id}`);
        data = await response.json();

        if (!data.success) {
            throw new Error('فشل جلب البيانات للتحقق');
        }

        const verified = data.data;
        console.log('✅ تم جلب البيانات من قاعدة البيانات:');
        console.log(`      - التقييم: ${verified.rating}`);
        console.log(`      - نقاط أكوادرا: ${verified.points}`);
        console.log(`      - رصيد المحفظة: ${verified.balance} ريال`);
        console.log(`      - الحالة: ${verified.status}`);
        console.log(`      - الصورة الشخصية: ${verified.avatar ? '✅ محفوظة' : '❌ غير محفوظة'}`);

        // Step 4: Verify persistence
        console.log('\n4️⃣ التحقق من الثبات...');
        const isRatingPersistent = parseFloat(verified.rating) === 4.8;
        const isPointsPersistent = parseInt(verified.points) === 150;
        const isBalancePersistent = parseFloat(verified.balance) === 500.50;
        const isStatusPersistent = verified.status === '👑 عضو ذهبي';
        const isAvatarPersistent = verified.avatar === 'https://api.dicebear.com/7.x/avataaars/svg?seed=test';

        console.log(`   ${isRatingPersistent ? '✅' : '❌'} التقييم ${isRatingPersistent ? 'محفوظ' : 'غير محفوظ'}`);
        console.log(`   ${isPointsPersistent ? '✅' : '❌'} نقاط أكوادرا ${isPointsPersistent ? 'محفوظة' : 'غير محفوظة'}`);
        console.log(`   ${isBalancePersistent ? '✅' : '❌'} رصيد المحفظة ${isBalancePersistent ? 'محفوظ' : 'غير محفوظ'}`);
        console.log(`   ${isStatusPersistent ? '✅' : '❌'} الحالة ${isStatusPersistent ? 'محفوظة' : 'غير محفوظة'}`);
        console.log(`   ${isAvatarPersistent ? '✅' : '❌'} الصورة الشخصية ${isAvatarPersistent ? 'محفوظة' : 'غير محفوظة'}`);

        if (isRatingPersistent && isPointsPersistent && isBalancePersistent && isStatusPersistent && isAvatarPersistent) {
            console.log('\n🎉 الاختبار نجح! جميع البيانات محفوظة بشكل دائم في قاعدة البيانات');
        } else {
            console.log('\n⚠️ بعض البيانات لم يتم حفظها بشكل صحيح');
        }

    } catch (error) {
        console.error('❌ خطأ في الاختبار:', error.message);
        process.exit(1);
    }
}

// Run the test
testPassengerUpdate()
    .then(() => {
        console.log('\n✅ اكتمل الاختبار');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ فشل الاختبار:', err);
        process.exit(1);
    });
