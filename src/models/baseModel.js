const pool = require('../config/database');

/**
 * Create a model for a database table with CRUD operations
 */
const createModel = (tableName) => {
    /**
     * Find all records with optional filters
     */
    const findAll = async (options = {}) => {
        const { where = {}, orderBy = 'created_at DESC', limit, offset, select = '*' } = options;
        
        let query = `SELECT ${select} FROM ${tableName}`;
        const values = [];
        let paramIndex = 1;

        // Build WHERE clause
        const whereKeys = Object.keys(where);
        if (whereKeys.length > 0) {
            const whereClauses = whereKeys.map(key => {
                values.push(where[key]);
                return `${key} = $${paramIndex++}`;
            });
            query += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        // Add ORDER BY
        if (orderBy) {
            query += ` ORDER BY ${orderBy}`;
        }

        // Add LIMIT and OFFSET
        if (limit) {
            query += ` LIMIT $${paramIndex++}`;
            values.push(limit);
        }
        if (offset) {
            query += ` OFFSET $${paramIndex++}`;
            values.push(offset);
        }

        const result = await pool.query(query, values);
        return result.rows;
    };

    /**
     * Find a single record by ID
     */
    const findById = async (id, select = '*') => {
        const query = `SELECT ${select} FROM ${tableName} WHERE id = $1`;
        const result = await pool.query(query, [id]);
        return result.rows[0] || null;
    };

    /**
     * Find a single record by conditions
     */
    const findOne = async (where, select = '*') => {
        let query = `SELECT ${select} FROM ${tableName}`;
        const values = [];
        let paramIndex = 1;

        const whereKeys = Object.keys(where);
        if (whereKeys.length > 0) {
            const whereClauses = whereKeys.map(key => {
                values.push(where[key]);
                return `${key} = $${paramIndex++}`;
            });
            query += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        query += ' LIMIT 1';

        const result = await pool.query(query, values);
        return result.rows[0] || null;
    };

    /**
     * Create a new record
     */
    const create = async (data) => {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

        const query = `
            INSERT INTO ${tableName} (${keys.join(', ')})
            VALUES (${placeholders})
            RETURNING *
        `;

        const result = await pool.query(query, values);
        return result.rows[0];
    };

    /**
     * Create multiple records
     */
    const createMany = async (records) => {
        if (!records || records.length === 0) return [];

        const keys = Object.keys(records[0]);
        const values = [];
        const valuePlaceholders = [];

        records.forEach((record, recordIndex) => {
            const recordPlaceholders = keys.map((key, keyIndex) => {
                values.push(record[key]);
                return `$${recordIndex * keys.length + keyIndex + 1}`;
            });
            valuePlaceholders.push(`(${recordPlaceholders.join(', ')})`);
        });

        const query = `
            INSERT INTO ${tableName} (${keys.join(', ')})
            VALUES ${valuePlaceholders.join(', ')}
            RETURNING *
        `;

        const result = await pool.query(query, values);
        return result.rows;
    };

    /**
     * Update a record by ID
     */
    const update = async (id, data) => {
        const keys = Object.keys(data);
        const values = Object.values(data);

        const setClauses = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');

        const query = `
            UPDATE ${tableName}
            SET ${setClauses}, updated_at = NOW()
            WHERE id = $${keys.length + 1}
            RETURNING *
        `;

        const result = await pool.query(query, [...values, id]);
        return result.rows[0];
    };

    /**
     * Update records by conditions
     */
    const updateWhere = async (where, data) => {
        const dataKeys = Object.keys(data);
        const dataValues = Object.values(data);
        const whereKeys = Object.keys(where);
        const whereValues = Object.values(where);

        const setClauses = dataKeys.map((key, i) => `${key} = $${i + 1}`).join(', ');
        const whereClauses = whereKeys.map((key, i) => `${key} = $${dataKeys.length + i + 1}`).join(' AND ');

        const query = `
            UPDATE ${tableName}
            SET ${setClauses}, updated_at = NOW()
            WHERE ${whereClauses}
            RETURNING *
        `;

        const result = await pool.query(query, [...dataValues, ...whereValues]);
        return result.rows;
    };

    /**
     * Delete a record by ID
     */
    const remove = async (id) => {
        const query = `DELETE FROM ${tableName} WHERE id = $1 RETURNING *`;
        const result = await pool.query(query, [id]);
        return result.rows[0];
    };

    /**
     * Delete records by conditions
     */
    const removeWhere = async (where) => {
        const keys = Object.keys(where);
        const values = Object.values(where);

        const whereClauses = keys.map((key, i) => `${key} = $${i + 1}`).join(' AND ');

        const query = `DELETE FROM ${tableName} WHERE ${whereClauses} RETURNING *`;
        const result = await pool.query(query, values);
        return result.rows;
    };

    /**
     * Count records
     */
    const count = async (where = {}) => {
        let query = `SELECT COUNT(*) as count FROM ${tableName}`;
        const values = [];
        let paramIndex = 1;

        const whereKeys = Object.keys(where);
        if (whereKeys.length > 0) {
            const whereClauses = whereKeys.map(key => {
                values.push(where[key]);
                return `${key} = $${paramIndex++}`;
            });
            query += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        const result = await pool.query(query, values);
        return parseInt(result.rows[0].count, 10);
    };

    /**
     * Check if record exists
     */
    const exists = async (where) => {
        const record = await findOne(where, 'id');
        return !!record;
    };

    /**
     * Upsert (insert or update)
     */
    const upsert = async (data, conflictFields) => {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

        const updateClauses = keys
            .filter(key => !conflictFields.includes(key))
            .map(key => `${key} = EXCLUDED.${key}`)
            .join(', ');

        const query = `
            INSERT INTO ${tableName} (${keys.join(', ')})
            VALUES (${placeholders})
            ON CONFLICT (${conflictFields.join(', ')})
            DO UPDATE SET ${updateClauses}, updated_at = NOW()
            RETURNING *
        `;

        const result = await pool.query(query, values);
        return result.rows[0];
    };

    /**
     * Execute raw SQL query
     */
    const raw = async (query, values = []) => {
        const result = await pool.query(query, values);
        return result.rows;
    };

    /**
     * Execute within a transaction
     */
    const transaction = async (callback) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    };

    /**
     * Search with ILIKE
     */
    const search = async (fields, searchTerm, options = {}) => {
        const { where = {}, orderBy = 'created_at DESC', limit = 50, offset = 0 } = options;
        
        let query = `SELECT * FROM ${tableName} WHERE `;
        const values = [];
        let paramIndex = 1;

        // Add search conditions
        const searchClauses = fields.map(field => {
            values.push(`%${searchTerm}%`);
            return `${field} ILIKE $${paramIndex++}`;
        });
        query += `(${searchClauses.join(' OR ')})`;

        // Add additional where conditions
        const whereKeys = Object.keys(where);
        if (whereKeys.length > 0) {
            const whereClauses = whereKeys.map(key => {
                values.push(where[key]);
                return `${key} = $${paramIndex++}`;
            });
            query += ` AND ${whereClauses.join(' AND ')}`;
        }

        query += ` ORDER BY ${orderBy} LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        values.push(limit, offset);

        const result = await pool.query(query, values);
        return result.rows;
    };

    /**
     * Get distinct values for a column
     */
    const distinct = async (column, where = {}) => {
        let query = `SELECT DISTINCT ${column} FROM ${tableName}`;
        const values = [];
        let paramIndex = 1;

        const whereKeys = Object.keys(where);
        if (whereKeys.length > 0) {
            const whereClauses = whereKeys.map(key => {
                values.push(where[key]);
                return `${key} = $${paramIndex++}`;
            });
            query += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        const result = await pool.query(query, values);
        return result.rows.map(row => row[column]);
    };

    return {
        tableName,
        findAll,
        findById,
        findOne,
        create,
        createMany,
        update,
        updateWhere,
        remove,
        removeWhere,
        count,
        exists,
        upsert,
        raw,
        transaction,
        search,
        distinct
    };
};

module.exports = { createModel };
