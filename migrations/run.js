/**
 * Migration Runner for Orchestrator Service
 * Executes SQL migration files in order
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'orchestrator_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres'
});

const migrationsDir = path.join(__dirname);

const runMigrations = async () => {
    const client = await pool.connect();
    
    try {
        console.log('Starting migrations...\n');

        // Create migrations tracking table
        await client.query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) UNIQUE NOT NULL,
                executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Get already executed migrations
        const { rows: executed } = await client.query(
            'SELECT filename FROM _migrations ORDER BY id'
        );
        const executedFiles = new Set(executed.map(r => r.filename));

        // Get migration files
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort();

        if (files.length === 0) {
            console.log('No migration files found.');
            return;
        }

        let migratedCount = 0;

        for (const file of files) {
            if (executedFiles.has(file)) {
                console.log(`⏭️  Skipping (already executed): ${file}`);
                continue;
            }

            console.log(`\n🔄 Running migration: ${file}`);
            
            const filePath = path.join(migrationsDir, file);
            const sql = fs.readFileSync(filePath, 'utf8');

            await client.query('BEGIN');
            
            try {
                // Execute migration
                await client.query(sql);
                
                // Record migration
                await client.query(
                    'INSERT INTO _migrations (filename) VALUES ($1)',
                    [file]
                );
                
                await client.query('COMMIT');
                console.log(`✅ Completed: ${file}`);
                migratedCount++;
            } catch (error) {
                await client.query('ROLLBACK');
                console.error(`❌ Failed: ${file}`);
                console.error(`   Error: ${error.message}`);
                throw error;
            }
        }

        console.log(`\n✨ Migrations completed! (${migratedCount} new, ${files.length - migratedCount} skipped)`);

    } finally {
        client.release();
        await pool.end();
    }
};

const rollbackMigration = async (filename) => {
    const client = await pool.connect();
    
    try {
        console.log(`Rolling back migration: ${filename}`);
        
        // Check if migration exists
        const { rows } = await client.query(
            'SELECT * FROM _migrations WHERE filename = $1',
            [filename]
        );
        
        if (rows.length === 0) {
            console.log('Migration not found in executed list.');
            return;
        }

        // Remove from tracking (actual rollback must be done manually)
        await client.query('DELETE FROM _migrations WHERE filename = $1', [filename]);
        console.log(`✅ Migration record removed: ${filename}`);
        console.log('⚠️  Note: Database changes must be rolled back manually if needed.');

    } finally {
        client.release();
        await pool.end();
    }
};

const listMigrations = async () => {
    const client = await pool.connect();
    
    try {
        // Ensure table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) UNIQUE NOT NULL,
                executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const { rows } = await client.query(
            'SELECT filename, executed_at FROM _migrations ORDER BY id'
        );

        console.log('\n📋 Executed Migrations:\n');
        
        if (rows.length === 0) {
            console.log('  No migrations executed yet.');
        } else {
            rows.forEach((row, i) => {
                console.log(`  ${i + 1}. ${row.filename}`);
                console.log(`     Executed: ${row.executed_at.toISOString()}`);
            });
        }

        // Show pending
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort();
        
        const executedFiles = new Set(rows.map(r => r.filename));
        const pending = files.filter(f => !executedFiles.has(f));

        console.log('\n📋 Pending Migrations:\n');
        
        if (pending.length === 0) {
            console.log('  All migrations are up to date.');
        } else {
            pending.forEach((file, i) => {
                console.log(`  ${i + 1}. ${file}`);
            });
        }

    } finally {
        client.release();
        await pool.end();
    }
};

// CLI
const command = process.argv[2];

const showHelp = () => {
    console.log(`
Orchestrator Service - Migration Runner

Usage:
  node run.js [command]

Commands:
  up          Run all pending migrations (default)
  list        List all migrations and their status
  rollback    Remove a migration record (requires filename argument)
  help        Show this help message

Examples:
  node run.js              # Run all pending migrations
  node run.js up           # Run all pending migrations
  node run.js list         # List all migrations
  node run.js rollback 001_initial_schema.sql
`);
};

const main = async () => {
    try {
        switch (command) {
            case 'list':
                await listMigrations();
                break;
            case 'rollback':
                const filename = process.argv[3];
                if (!filename) {
                    console.error('Error: Please provide migration filename to rollback');
                    process.exit(1);
                }
                await rollbackMigration(filename);
                break;
            case 'help':
                showHelp();
                break;
            case 'up':
            default:
                await runMigrations();
                break;
        }
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        process.exit(1);
    }
};

main();
