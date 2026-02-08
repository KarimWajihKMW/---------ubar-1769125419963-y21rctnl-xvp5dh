const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  connectionString: 'postgresql://postgres:gnQuusUxfjjvwiryBRkdvFjzBkXhEieJ@trolley.proxy.rlwy.net:47888/railway'
});

async function testDriverId() {
  console.log('🔍 Testing driver_id column in users table...\n');
  
  try {
    // Test 1: Check if driver_id column exists
    console.log('Test 1: Checking if driver_id column exists...');
    const columnCheck = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'driver_id'
    `);
    
    if (columnCheck.rows.length > 0) {
      console.log('✅ driver_id column exists:', columnCheck.rows[0]);
    } else {
      console.log('❌ driver_id column does not exist');
      return;
    }
    
    // Test 2: Check drivers have driver_id
    console.log('\nTest 2: Checking if drivers have driver_id assigned...');
    const driversCheck = await pool.query(`
      SELECT id, name, role, driver_id 
      FROM users 
      WHERE role = 'driver'
      ORDER BY id
    `);
    
    console.log(`Found ${driversCheck.rows.length} drivers:`);
    driversCheck.rows.forEach(driver => {
      const status = driver.driver_id ? '✅' : '❌';
      console.log(`${status} ID: ${driver.id}, Name: ${driver.name}, driver_id: ${driver.driver_id}`);
    });
    
    // Test 3: Check passengers don't have driver_id
    console.log('\nTest 3: Checking passengers (should have NULL driver_id)...');
    const passengersCheck = await pool.query(`
      SELECT id, name, role, driver_id 
      FROM users 
      WHERE role = 'passenger'
      LIMIT 5
    `);
    
    console.log(`Checking ${passengersCheck.rows.length} passengers (sample):`);
    passengersCheck.rows.forEach(passenger => {
      const status = passenger.driver_id === null ? '✅' : '❌';
      console.log(`${status} ID: ${passenger.id}, Name: ${passenger.name}, driver_id: ${passenger.driver_id}`);
    });
    
    // Test 4: Check index exists
    console.log('\nTest 4: Checking if index on driver_id exists...');
    const indexCheck = await pool.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'users' AND indexname = 'idx_users_driver_id'
    `);
    
    if (indexCheck.rows.length > 0) {
      console.log('✅ Index idx_users_driver_id exists');
    } else {
      console.log('❌ Index idx_users_driver_id does not exist');
    }
    
    // Test 5: Test query performance with driver_id
    console.log('\nTest 5: Testing query with driver_id...');
    const queryTest = await pool.query(`
      SELECT id, name, role, driver_id 
      FROM users 
      WHERE driver_id = 5
    `);
    
    if (queryTest.rows.length > 0) {
      console.log('✅ Query by driver_id works:', queryTest.rows[0]);
    } else {
      console.log('ℹ️ No driver found with driver_id = 5');
    }
    
    console.log('\n✅ All tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Error during testing:', error.message);
  } finally {
    await pool.end();
  }
}

testDriverId();
