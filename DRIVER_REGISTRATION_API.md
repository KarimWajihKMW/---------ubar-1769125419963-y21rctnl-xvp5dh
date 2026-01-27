# Driver Registration API Documentation

## Overview
This API provides endpoints for driver registration, approval workflow, and document management.

## Features
- New driver registration with document upload
- Three required documents: ID card, driver's license, vehicle license
- Admin approval workflow
- Status tracking
- Rejection with reason

## Endpoints

### 1. Register New Driver
**POST** `/api/drivers/register`

Register a new driver with required documents.

**Content-Type**: `multipart/form-data`

**Request Body**:
```
name: string (required) - Driver's full name
phone: string (required) - Driver's phone number (unique)
email: string (required) - Driver's email (unique)
password: string (required) - Driver's password
car_type: string (optional) - Type of car (economy, family, luxury). Default: economy
car_plate: string (optional) - Vehicle plate number
id_card_photo: file (required) - ID card photo (jpg, jpeg, png, pdf, max 5MB)
drivers_license: file (required) - Driver's license (jpg, jpeg, png, pdf, max 5MB)
vehicle_license: file (required) - Vehicle license (jpg, jpeg, png, pdf, max 5MB)
```

**Response** (201 Created):
```json
{
  "success": true,
  "message": "Driver registration submitted. Waiting for admin approval.",
  "data": {
    "id": 9,
    "name": "عبدالله محمد الأحمد",
    "phone": "0501111111",
    "email": "abdullah@test.sa",
    "car_type": "economy",
    "car_plate": "أ ب ج 9999",
    "id_card_photo": "/uploads/id_card_photo-1769524222046-832813393.jpg",
    "drivers_license": "/uploads/drivers_license-1769524222047-943590583.jpg",
    "vehicle_license": "/uploads/vehicle_license-1769524222047-284353188.jpg",
    "approval_status": "pending",
    "created_at": "2026-01-27T14:30:22.244Z"
  }
}
```

**Example cURL**:
```bash
curl -X POST http://localhost:3000/api/drivers/register \
  -F "name=عبدالله محمد الأحمد" \
  -F "phone=0501111111" \
  -F "email=abdullah@test.sa" \
  -F "password=test1234" \
  -F "car_type=economy" \
  -F "car_plate=أ ب ج 9999" \
  -F "id_card_photo=@/path/to/id_card.jpg" \
  -F "drivers_license=@/path/to/license.jpg" \
  -F "vehicle_license=@/path/to/vehicle.jpg"
```

### 2. Check Driver Status
**GET** `/api/drivers/status/:phone`

Check the registration status of a driver by phone number.

**URL Parameters**:
- `phone`: Driver's phone number

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": 9,
    "name": "عبدالله محمد الأحمد",
    "phone": "0501111111",
    "email": "abdullah@test.sa",
    "car_type": "economy",
    "car_plate": "أ ب ج 9999",
    "approval_status": "pending",
    "rejection_reason": null,
    "created_at": "2026-01-27T14:30:22.244Z",
    "approved_at": null
  }
}
```

**Example cURL**:
```bash
curl http://localhost:3000/api/drivers/status/0501111111
```

### 3. Get Pending Registrations
**GET** `/api/drivers/pending`

Get all pending driver registrations (Admin only).

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": 9,
      "name": "عبدالله محمد الأحمد",
      "phone": "0501111111",
      "email": "abdullah@test.sa",
      "car_type": "economy",
      "car_plate": "أ ب ج 9999",
      "id_card_photo": "/uploads/id_card_photo-1769524222046-832813393.jpg",
      "drivers_license": "/uploads/drivers_license-1769524222047-943590583.jpg",
      "vehicle_license": "/uploads/vehicle_license-1769524222047-284353188.jpg",
      "approval_status": "pending",
      "created_at": "2026-01-27T14:30:22.244Z"
    }
  ]
}
```

**Example cURL**:
```bash
curl http://localhost:3000/api/drivers/pending
```

### 4. Approve or Reject Driver
**PATCH** `/api/drivers/:id/approval`

Approve or reject a driver registration (Admin only).

**URL Parameters**:
- `id`: Driver ID

**Request Body** (JSON):
```json
{
  "approval_status": "approved",  // or "rejected"
  "approved_by": 8,               // Admin user ID (optional)
  "rejection_reason": "الوثائق غير واضحة"  // Required only for rejection
}
```

**Response** (200 OK) - Approved:
```json
{
  "success": true,
  "message": "Driver approved successfully",
  "data": {
    "id": 9,
    "name": "عبدالله محمد الأحمد",
    "phone": "0501111111",
    "email": "abdullah@test.sa",
    "approval_status": "approved",
    "approved_by": 8,
    "approved_at": "2026-01-27T14:31:29.265Z",
    "status": "offline",
    "rating": "5.00",
    "total_trips": 0
  }
}
```

**Response** (200 OK) - Rejected:
```json
{
  "success": true,
  "message": "Driver rejected successfully",
  "data": {
    "id": 10,
    "name": "محمد سعيد الغامدي",
    "phone": "0502222222",
    "approval_status": "rejected",
    "rejection_reason": "الوثائق غير واضحة"
  }
}
```

**Example cURL - Approve**:
```bash
curl -X PATCH http://localhost:3000/api/drivers/9/approval \
  -H "Content-Type: application/json" \
  -d '{"approval_status":"approved","approved_by":8}'
```

**Example cURL - Reject**:
```bash
curl -X PATCH http://localhost:3000/api/drivers/10/approval \
  -H "Content-Type: application/json" \
  -d '{"approval_status":"rejected","rejection_reason":"الوثائق غير واضحة"}'
```

## Database Schema

### Drivers Table
```sql
CREATE TABLE drivers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE,
    password VARCHAR(255),
    car_type VARCHAR(50) DEFAULT 'economy',
    car_plate VARCHAR(20),
    id_card_photo TEXT,
    drivers_license TEXT,
    vehicle_license TEXT,
    approval_status VARCHAR(20) DEFAULT 'pending',
    approved_by INTEGER,
    approved_at TIMESTAMP,
    rejection_reason TEXT,
    rating DECIMAL(3, 2) DEFAULT 5.00,
    total_trips INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'offline',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Approval Workflow

1. **Driver Registration**: 
   - Driver submits registration with all required documents
   - Status is set to "pending"
   - Driver status is "offline"

2. **Admin Review**:
   - Admin retrieves pending registrations
   - Reviews uploaded documents
   - Makes decision to approve or reject

3. **Approval**:
   - Status changed to "approved"
   - Driver can now go online and accept trips
   - User account created/updated with "driver" role

4. **Rejection**:
   - Status changed to "rejected"
   - Rejection reason is recorded
   - Driver can view rejection reason and re-apply

## File Upload

### Supported Formats
- JPEG (.jpg, .jpeg)
- PNG (.png)
- PDF (.pdf)

### File Size Limit
- Maximum: 5MB per file

### Storage
- Files are stored in `/uploads` directory
- Filenames are automatically generated with timestamp and random suffix
- Accessible via `/uploads/:filename` URL

## Error Responses

### 400 Bad Request
```json
{
  "success": false,
  "error": "All three documents (ID card, driver's license, vehicle license) are required"
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "Driver not found"
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "error": "Error message details"
}
```

## Status Codes

- `pending` - Registration submitted, waiting for admin approval
- `approved` - Driver approved and can accept trips
- `rejected` - Registration rejected by admin

## Notes

- Phone numbers and emails must be unique
- All three documents are mandatory for registration
- Approved drivers automatically get a user account created
- Rejection reason is optional but recommended for transparency
