# ميزة الحفظ التلقائي للملف الشخصي للراكب
# Passenger Profile Auto-Save Feature

## نظرة عامة | Overview

تم تنفيذ ميزة الحفظ التلقائي التي تحفظ تعديلات الملف الشخصي للراكب في قاعدة البيانات فوراً عند التعديل، دون الحاجة للنقر على زر "حفظ".

**Auto-save feature implemented that saves passenger profile edits to the database immediately upon editing, without needing to click a "Save" button.**

---

## الميزات الرئيسية | Key Features

### 1. الحفظ التلقائي الفوري
**Immediate Auto-Save**

- عند تعديل أي حقل في الملف الشخصي، يتم حفظ التغييرات تلقائياً
- When editing any field in the profile, changes are saved automatically
- الحفظ يتم عند:
  - فقدان المجال للتركيز (blur event)
  - بعد ثانية واحدة من توقف الكتابة (debounced)

### 2. إشعارات مرئية
**Visual Notifications**

- إشعار أخضر: ✅ تم الحفظ تلقائياً
- إشعار أحمر: ❌ فشل الحفظ
- الإشعارات تظهر لمدة 3 ثواني ثم تختفي تلقائياً

### 3. التوافق
**Compatibility**

- يعمل مع الركاب (passengers)
- يعمل مع المستخدمين العاديين (users)
- يدعم جميع الحقول القابلة للتعديل:
  - الاسم (Name)
  - رقم الهاتف (Phone)
  - البريد الإلكتروني (Email)
  - نوع السيارة (Car Type)
  - رقم اللوحة (Plate Number)
  - الرصيد (Balance)
  - النقاط (Points)
  - التقييم (Rating)
  - الحالة (Status)

---

## كيفية الاستخدام | How to Use

### للراكب | For Passengers

1. **تسجيل الدخول**
   - افتح التطبيق وسجل الدخول كراكب
   - Open the app and login as a passenger

2. **الدخول للملف الشخصي**
   - انتقل إلى صفحة الملف الشخصي (`profile.html`)
   - Navigate to the profile page (`profile.html`)

3. **تفعيل وضع التعديل**
   - انقر على زر "تعديل الملف الشخصي"
   - Click the "Edit Profile" button

4. **التعديل والحفظ التلقائي**
   - ابدأ بتعديل أي حقل (الاسم، البريد الإلكتروني، إلخ.)
   - Start editing any field (name, email, etc.)
   - عند الانتقال لحقل آخر أو التوقف عن الكتابة:
     - سيتم حفظ التغييرات تلقائياً في قاعدة البيانات
     - سيظهر إشعار "✅ تم الحفظ تلقائياً"
   - When moving to another field or stopping typing:
     - Changes will be auto-saved to database
     - Notification "✅ تم الحفظ تلقائياً" will appear

5. **متابعة التعديل**
   - يمكنك الاستمرار في تعديل حقول أخرى
   - كل حقل سيُحفظ تلقائياً بمجرد الانتهاء منه
   - You can continue editing other fields
   - Each field will be auto-saved as soon as you finish

---

## التفاصيل التقنية | Technical Details

### الملفات المعدلة | Modified Files

1. **profile.html**
   - أضيفت دالة `enableAutoSave()` - Enable auto-save listeners
   - أضيفت دالة `handleAutoSave()` - Handle auto-save on blur
   - أضيفت دالة `scheduleAutoSave()` - Debounce typing (1 second)
   - أضيفت دالة `saveProfileEditsAuto()` - Save to database
   - أضيفت دالة `showAutoSaveNotification()` - Show save status
   - أضيفت CSS animations للإشعارات

### ملفات جديدة | New Files

2. **test-passenger-autosave.js**
   - اختبارات شاملة للتأكد من عمل الميزة
   - Comprehensive tests to verify feature works
   - يختبر:
     - تحديث بيانات الراكب عبر API
     - حفظ التغييرات في قاعدة البيانات
     - استمرارية البيانات المحدثة

---

## واجهة برمجة التطبيقات | API Endpoints

### تحديث الراكب | Update Passenger

```http
PUT /api/passengers/:id
Content-Type: application/json

{
  "name": "الاسم الجديد",
  "phone": "0551234567",
  "email": "email@example.com",
  "car_type": "نوع السيارة",
  "car_plate": "رقم اللوحة"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "الاسم الجديد",
    "phone": "0551234567",
    "email": "email@example.com",
    "updated_at": "2026-02-05T13:30:00.000Z"
  }
}
```

---

## الاختبارات | Testing

### تشغيل الاختبار | Run Test

```bash
node test-passenger-autosave.js
```

### نتائج الاختبار | Test Results

```
✅ Passenger profile can be updated via API
✅ Changes are saved immediately to database
✅ Updated values persist across fetches
✅ Auto-save functionality is working correctly
```

---

## التحسينات المستقبلية | Future Improvements

1. **Offline Support**
   - حفظ التغييرات محلياً عند عدم توفر الإنترنت
   - مزامنة تلقائية عند استعادة الاتصال

2. **Conflict Resolution**
   - التعامل مع التعديلات المتزامنة من أجهزة متعددة

3. **History Tracking**
   - سجل بجميع التعديلات السابقة

4. **Undo/Redo**
   - إمكانية التراجع عن التعديلات

---

## معلومات الالتزام | Commit Information

- **Commit ID:** bd7ec78
- **Date:** 2026-02-05
- **Files Changed:** 2 files (profile.html, test-passenger-autosave.js)
- **Changes:** +346 insertions

---

## الملاحظات | Notes

- الحفظ التلقائي يعمل فقط في وضع التعديل
- Auto-save only works in edit mode
- يتم التحقق من صحة البيانات قبل الحفظ
- Data validation occurs before saving
- يتم تحديث localStorage أيضاً لتحسين الأداء
- localStorage is also updated for better performance

---

## الدعم | Support

في حالة وجود مشاكل أو أسئلة، يرجى:
- مراجعة سجلات المتصفح (Console)
- التحقق من سجلات الخادم (server.log)
- تشغيل الاختبارات للتأكد من عمل النظام

For issues or questions:
- Check browser console logs
- Review server logs (server.log)
- Run tests to verify system functionality

---

## الحالة | Status

✅ **تم التنفيذ والاختبار بنجاح**
✅ **Successfully Implemented and Tested**
✅ **تم الالتزام والدفع إلى الفرع الرئيسي**
✅ **Committed and Pushed to Main Branch**
