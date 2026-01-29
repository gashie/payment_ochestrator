/**
 * Orchestrator Middlewares Index
 */

const auth = require('./auth');
const common = require('./common');

module.exports = {
    ...auth,
    ...common
};
