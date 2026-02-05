#!/usr/bin/env node

/**
 * Test script for passenger profile auto-save functionality
 * Tests that profile changes are saved immediately to the database
 */

const API_BASE = 'http://localhost:3000/api';

async function testPassengerAutoSave() {
    console.log('🧪 Testing Passenger Profile Auto-Save Functionality\n');
    console.log('='.repeat(60));
    
    try {
        // Step 1: Get an existing passenger
        console.log('\n📋 Step 1: Fetching existing passenger...');
        const passengersResponse = await fetch(`${API_BASE}/passengers`);
        const passengersData = await passengersResponse.json();
        
        if (!passengersData.success || passengersData.data.length === 0) {
            console.error('❌ No passengers found in database');
            process.exit(1);
        }
        
        const testPassenger = passengersData.data[0];
        console.log('✅ Found passenger:', {
            id: testPassenger.id,
            name: testPassenger.name,
            phone: testPassenger.phone,
            email: testPassenger.email
        });
        
        // Step 2: Store original values
        console.log('\n📋 Step 2: Storing original values...');
        const originalName = testPassenger.name;
        const originalEmail = testPassenger.email;
        console.log('✅ Original values stored');
        
        // Step 3: Simulate profile edit (auto-save)
        console.log('\n📋 Step 3: Simulating profile edit with auto-save...');
        const timestamp = Date.now();
        const newName = `تم التحديث تلقائياً ${timestamp}`;
        const newEmail = `autosaved_${timestamp}@test.sa`;
        
        const updateData = {
            name: newName,
            phone: testPassenger.phone,
            email: newEmail
        };
        
        console.log('📝 Updating with:', updateData);
        
        const updateResponse = await fetch(`${API_BASE}/passengers/${testPassenger.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updateData)
        });
        
        const updateResult = await updateResponse.json();
        
        if (!updateResult.success) {
            console.error('❌ Update failed:', updateResult.error);
            process.exit(1);
        }
        
        console.log('✅ Update successful');
        console.log('Updated data:', {
            name: updateResult.data.name,
            email: updateResult.data.email
        });
        
        // Step 4: Verify the changes were saved
        console.log('\n📋 Step 4: Verifying changes were saved to database...');
        const verifyResponse = await fetch(`${API_BASE}/passengers/${testPassenger.id}`);
        const verifyData = await verifyResponse.json();
        
        if (!verifyData.success) {
            console.error('❌ Failed to fetch passenger for verification');
            process.exit(1);
        }
        
        const savedPassenger = verifyData.data;
        console.log('✅ Fetched updated passenger from database');
        
        // Verify name
        if (savedPassenger.name !== newName) {
            console.error('❌ Name mismatch!');
            console.error('Expected:', newName);
            console.error('Got:', savedPassenger.name);
            process.exit(1);
        }
        console.log('✅ Name verified:', savedPassenger.name);
        
        // Verify email
        if (savedPassenger.email !== newEmail) {
            console.error('❌ Email mismatch!');
            console.error('Expected:', newEmail);
            console.error('Got:', savedPassenger.email);
            process.exit(1);
        }
        console.log('✅ Email verified:', savedPassenger.email);
        
        // Step 5: Restore original values
        console.log('\n📋 Step 5: Restoring original values...');
        const restoreResponse = await fetch(`${API_BASE}/passengers/${testPassenger.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: originalName,
                phone: testPassenger.phone,
                email: originalEmail
            })
        });
        
        const restoreResult = await restoreResponse.json();
        
        if (!restoreResult.success) {
            console.error('❌ Failed to restore original values');
            process.exit(1);
        }
        
        console.log('✅ Original values restored');
        
        // Final summary
        console.log('\n' + '='.repeat(60));
        console.log('✅✅✅ ALL TESTS PASSED! ✅✅✅');
        console.log('='.repeat(60));
        console.log('\n📊 Test Summary:');
        console.log('  ✅ Passenger profile can be updated via API');
        console.log('  ✅ Changes are saved immediately to database');
        console.log('  ✅ Updated values persist across fetches');
        console.log('  ✅ Auto-save functionality is working correctly');
        console.log('\n🎉 The passenger profile auto-save feature is working as expected!\n');
        
        process.exit(0);
        
    } catch (error) {
        console.error('\n❌ Test failed with error:', error.message);
        console.error(error);
        process.exit(1);
    }
}

// Run the test
testPassengerAutoSave();
