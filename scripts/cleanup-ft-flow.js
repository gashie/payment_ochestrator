/**
 * Cleanup script to remove old FT flow before re-seeding
 * Run this before seed.js to get the simplified FT flow
 */

const pool = require('../src/config/database');

async function cleanupFtFlow() {
    const client = await pool.connect();

    try {
        console.log('Starting FT Flow cleanup...\n');

        await client.query('BEGIN');

        // Get the FT flow ID
        const flowResult = await client.query(
            "SELECT id, flow_name FROM flows WHERE flow_code = 'FT_FLOW'"
        );

        if (flowResult.rows.length === 0) {
            console.log('No FT_FLOW found in database. Nothing to clean up.');
            await client.query('COMMIT');
            return;
        }

        const flowId = flowResult.rows[0].id;
        const flowName = flowResult.rows[0].flow_name;
        console.log(`Found FT Flow: ${flowName} (ID: ${flowId})`);

        // Delete step transitions
        const transitionsResult = await client.query(
            'DELETE FROM step_transitions WHERE flow_id = $1 RETURNING id',
            [flowId]
        );
        console.log(`Deleted ${transitionsResult.rowCount} step transitions`);

        // Delete flow steps
        const stepsResult = await client.query(
            'DELETE FROM flow_steps WHERE flow_id = $1 RETURNING id',
            [flowId]
        );
        console.log(`Deleted ${stepsResult.rowCount} flow steps`);

        // Delete flow versions
        const versionsResult = await client.query(
            'DELETE FROM flow_versions WHERE flow_id = $1 RETURNING id',
            [flowId]
        );
        console.log(`Deleted ${versionsResult.rowCount} flow versions`);

        // Delete the flow itself
        await client.query(
            'DELETE FROM flows WHERE id = $1',
            [flowId]
        );
        console.log('Deleted FT_FLOW');

        await client.query('COMMIT');

        console.log('\n✓ FT Flow cleanup complete!');
        console.log('Now run: node scripts/seed.js');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Cleanup failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

cleanupFtFlow().catch(err => {
    console.error(err);
    process.exit(1);
});
