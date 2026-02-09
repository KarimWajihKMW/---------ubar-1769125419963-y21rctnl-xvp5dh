/**
 * نظام المزامنة الشامل للسائقين
 * يربط كل شيء متعلق بالسائقين بقاعدة البيانات
 * مزامنة ثنائية الاتجاه: التطبيق ⇄ قاعدة البيانات
 */

const pool = require('./db');

/**
 * Sync driver data from database to ensure consistency
 */
async function syncDriverFromDatabase(driverId) {
    const client = await pool.connect();
    try {
        // Get fresh data from database
        const result = await client.query(`
            SELECT * FROM drivers WHERE id = $1
        `, [driverId]);

        if (result.rows.length === 0) {
            throw new Error(`Driver ${driverId} not found`);
        }

        return result.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Update driver in database and trigger sync
 */
async function updateDriverInDatabase(driverId, updates) {
    const client = await pool.connect();
    try {
        const fields = [];
        const values = [];
        let paramCount = 1;

        // Build dynamic update query
        Object.keys(updates).forEach(key => {
            if (key !== 'id') {
                fields.push(`${key} = $${paramCount}`);
                values.push(updates[key]);
                paramCount++;
            }
        });

        if (fields.length === 0) {
            throw new Error('No fields to update');
        }

        // Always update the updated_at timestamp
        fields.push(`updated_at = CURRENT_TIMESTAMP`);

        values.push(driverId);
        const query = `
            UPDATE drivers 
            SET ${fields.join(', ')}
            WHERE id = $${paramCount}
            RETURNING *
        `;

        const result = await client.query(query, values);

        if (result.rows.length === 0) {
            throw new Error(`Driver ${driverId} not found`);
        }

        console.log(`✅ Driver ${driverId} updated in database:`, updates);
        return result.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Sync driver earnings between tables
 */
async function syncDriverEarnings(driverId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Get current driver data
        const driverResult = await client.query(
            'SELECT today_trips_count, today_earnings, total_trips, total_earnings FROM drivers WHERE id = $1',
            [driverId]
        );

        if (driverResult.rows.length === 0) {
            throw new Error(`Driver ${driverId} not found`);
        }

        const driver = driverResult.rows[0];

        // Update or insert into driver_earnings
        await client.query(`
            INSERT INTO driver_earnings (
                driver_id, 
                date, 
                today_trips, 
                today_earnings, 
                total_trips, 
                total_earnings,
                created_at,
                updated_at
            )
            VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (driver_id, date) 
            DO UPDATE SET
                today_trips = $2,
                today_earnings = $3,
                total_trips = $4,
                total_earnings = $5,
                updated_at = CURRENT_TIMESTAMP
        `, [
            driverId,
            driver.today_trips_count || 0,
            driver.today_earnings || 0,
            driver.total_trips || 0,
            driver.total_earnings || 0
        ]);

        await client.query('COMMIT');
        console.log(`✅ Earnings synced for driver ${driverId}`);
        
        return true;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`❌ Error syncing earnings for driver ${driverId}:`, error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Sync all drivers' earnings
 */
async function syncAllDriversEarnings() {
    const client = await pool.connect();
    try {
        // Get all drivers
        const result = await client.query('SELECT id FROM drivers');
        const drivers = result.rows;

        console.log(`🔄 Syncing earnings for ${drivers.length} drivers...`);

        for (const driver of drivers) {
            try {
                await syncDriverEarnings(driver.id);
            } catch (error) {
                console.error(`❌ Error syncing driver ${driver.id}:`, error.message);
            }
        }

        console.log(`✅ All drivers' earnings synced`);
    } finally {
        client.release();
    }
}

/**
 * Listen for database changes using PostgreSQL LISTEN/NOTIFY
 */
async function setupDatabaseListener(onDriverUpdate) {
    const client = await pool.connect();
    
    try {
        // Listen for driver updates
        await client.query('LISTEN driver_updates');
        
        client.on('notification', async (msg) => {
            if (msg.channel === 'driver_updates') {
                const payload = JSON.parse(msg.payload);
                console.log('📡 Database change detected:', payload);
                
                if (onDriverUpdate && typeof onDriverUpdate === 'function') {
                    await onDriverUpdate(payload);
                }
            }
        });

        console.log('👂 Listening for database changes...');
    } catch (error) {
        console.error('❌ Error setting up database listener:', error);
        client.release();
    }
}

/**
 * Create database triggers for automatic sync
 */
async function createDatabaseTriggers() {
    const client = await pool.connect();
    try {
        // Create trigger function for driver updates
        await client.query(`
            CREATE OR REPLACE FUNCTION notify_driver_update()
            RETURNS TRIGGER AS $$
            BEGIN
                PERFORM pg_notify('driver_updates', 
                    json_build_object(
                        'operation', TG_OP,
                        'driver_id', NEW.id,
                        'timestamp', NOW()
                    )::text
                );
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        // Create trigger on drivers table
        await client.query(`
            DROP TRIGGER IF EXISTS driver_update_trigger ON drivers;
            CREATE TRIGGER driver_update_trigger
            AFTER INSERT OR UPDATE ON drivers
            FOR EACH ROW
            EXECUTE FUNCTION notify_driver_update();
        `);

        // Create trigger function for earnings updates
        await client.query(`
            CREATE OR REPLACE FUNCTION sync_driver_from_earnings()
            RETURNS TRIGGER AS $$
            BEGIN
                -- Update drivers table when driver_earnings is updated
                -- Only update if this is today's record
                IF NEW.date = CURRENT_DATE THEN
                    UPDATE drivers
                    SET 
                        today_trips_count = NEW.today_trips,
                        today_earnings = NEW.today_earnings,
                        total_trips = NEW.total_trips,
                        total_earnings = NEW.total_earnings,
                        last_earnings_update = CURRENT_DATE,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = NEW.driver_id;
                END IF;
                
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        // Create trigger on driver_earnings table
        await client.query(`
            DROP TRIGGER IF EXISTS earnings_to_driver_sync_trigger ON driver_earnings;
            CREATE TRIGGER earnings_to_driver_sync_trigger
            AFTER INSERT OR UPDATE ON driver_earnings
            FOR EACH ROW
            WHEN (NEW.date = CURRENT_DATE)
            EXECUTE FUNCTION sync_driver_from_earnings();
        `);

        console.log('✅ Database triggers created successfully');
    } catch (error) {
        console.error('❌ Error creating database triggers:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Initialize the sync system
 */
async function initializeSyncSystem() {
    console.log('🚀 Initializing Driver Sync System...');
    
    try {
        // Create database triggers
        await createDatabaseTriggers();
        
        // Sync all drivers initially
        await syncAllDriversEarnings();
        
        console.log('✅ Driver Sync System initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing sync system:', error);
        throw error;
    }
}

/**
 * Reset today's earnings for all drivers (run at midnight)
 */
async function resetTodayEarnings() {
    const client = await pool.connect();
    try {
        await client.query(`
            UPDATE drivers 
            SET 
                today_trips_count = 0,
                today_earnings = 0,
                last_earnings_reset = CURRENT_TIMESTAMP
            WHERE 1=1
        `);

        console.log('✅ Today\'s earnings reset for all drivers');
    } catch (error) {
        console.error('❌ Error resetting today\'s earnings:', error);
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    syncDriverFromDatabase,
    updateDriverInDatabase,
    syncDriverEarnings,
    syncAllDriversEarnings,
    setupDatabaseListener,
    createDatabaseTriggers,
    initializeSyncSystem,
    resetTodayEarnings
};
