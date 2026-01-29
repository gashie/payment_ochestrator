# Orchestrator Service

A dynamic workflow orchestration engine for payment processing. This service receives requests from the Bank Flow System (BFS), executes configurable BPMN-like flows, and manages the complete transaction lifecycle including callbacks, TSQ (Transaction Status Query), and reversals.

## Features

- **Dynamic Flow Engine**: BPMN-like workflow execution with configurable steps
- **Visual Flow Diagrams**: Generate visual BPMN diagrams of flows
- **Callback Management**: Handle and match incoming callbacks with flow instances
- **TSQ Processing**: Automatic Transaction Status Query with retry logic
- **Reversal Handling**: Automatic and manual reversal processing
- **Real-time Monitoring**: Track flow instances, step executions, and system health
- **Comprehensive Logging**: Process logs, event logs, and audit trails
- **Alert System**: Configurable alerts via webhook, email, and SMS

## Architecture

```
┌─────────────────┐    ┌─────────────────────────────────────┐
│  Bank Flow      │───▶│           Orchestrator               │
│  System (BFS)   │◀───│                                      │
└─────────────────┘    │  ┌─────────┐  ┌─────────────────┐   │
                       │  │  Flow   │  │   Callback      │   │
                       │  │  Engine │  │   Processor     │   │
                       │  └────┬────┘  └────────┬────────┘   │
                       │       │                │            │
                       │  ┌────▼────────────────▼────────┐   │
                       │  │        PostgreSQL DB          │   │
                       │  └───────────────────────────────┘   │
                       └─────────────────────────────────────┘
                                      │
                                      ▼
                       ┌─────────────────────────────────────┐
                       │         External APIs (GIP)         │
                       └─────────────────────────────────────┘
```

## Flow Step Types

| Type | Description |
|------|-------------|
| `START` | Flow entry point |
| `END` | Flow completion point |
| `TRANSFORM` | Apply field mappings and transformations |
| `API_CALL` | Call external API |
| `CALLBACK` | Wait for external callback |
| `LISTENER` | Listen for events |
| `CONDITION` | Evaluate conditions for branching |
| `GATEWAY` | Decision gateway (XOR, AND, OR) |
| `TASK` | Execute generic task |
| `MANUAL` | Require human intervention |
| `ALERT` | Send alert notification |

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- npm or yarn

## Installation

1. **Clone and Install Dependencies**
   ```bash
   cd orchestrator
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Create Database**
   ```bash
   createdb orchestrator_db
   ```

4. **Run Migrations**
   ```bash
   npm run migrate
   ```

5. **Seed Sample Data**
   ```bash
   npm run seed
   ```

6. **Start Server**
   ```bash
   # Development
   npm run dev
   
   # Production
   npm start
   ```

## API Endpoints

### Flow Management
- `GET /api/v1/flows` - List all flows
- `POST /api/v1/flows` - Create new flow
- `GET /api/v1/flows/:id` - Get flow details with steps
- `PUT /api/v1/flows/:id` - Update flow
- `GET /api/v1/flows/:id/diagram` - Get BPMN diagram
- `POST /api/v1/flows/:id/version` - Create new flow version

### Flow Steps
- `GET /api/v1/flows/:flowId/steps` - List flow steps
- `POST /api/v1/flows/:flowId/steps` - Add step to flow
- `PUT /api/v1/flows/:flowId/steps/:stepId` - Update step
- `DELETE /api/v1/flows/:flowId/steps/:stepId` - Remove step
- `POST /api/v1/flows/:flowId/steps/:stepId/transitions` - Add transition

### Field Mappings
- `GET /api/v1/mappings` - List field mappings
- `POST /api/v1/mappings` - Create field mapping
- `GET /api/v1/mappings/:id` - Get mapping details
- `PUT /api/v1/mappings/:id` - Update mapping

### Process Execution
- `POST /api/v1/process/execute` - Execute a flow
- `GET /api/v1/process/instances` - List flow instances
- `GET /api/v1/process/instances/:id` - Get instance details
- `POST /api/v1/process/instances/:id/resume` - Resume paused instance
- `POST /api/v1/process/instances/:id/cancel` - Cancel instance
- `POST /api/v1/process/instances/:id/manual-complete` - Complete manual step

### Callbacks
- `POST /api/v1/callbacks/receive` - Receive external callback
- `GET /api/v1/callbacks/pending` - List pending callbacks
- `GET /api/v1/callbacks/unmatched` - List unmatched callbacks

### Monitoring
- `GET /api/v1/monitoring/dashboard` - Dashboard statistics
- `GET /api/v1/monitoring/instances/active` - Active flow instances
- `GET /api/v1/monitoring/instances/failed` - Failed instances
- `GET /api/v1/monitoring/callbacks/pending` - Pending callbacks
- `GET /api/v1/monitoring/tsq/status` - TSQ processing status
- `GET /api/v1/monitoring/health` - System health check

### Reports
- `GET /api/v1/reports/flow-statistics` - Flow execution statistics
- `GET /api/v1/reports/instance-report` - Instance detail report
- `GET /api/v1/reports/callback-report` - Callback statistics
- `GET /api/v1/reports/tsq-report` - TSQ statistics

## Sample Flows

### Name Enquiry (NEC) Flow
Synchronous flow for account name verification:

```
START → Transform Request → Call GIP NEC → Transform Response → END
```

### Funds Transfer (FT) Flow
Asynchronous flow for complete funds transfer:

```
START → NEC(src) → NEC(dest) → FTD Request → Wait Callback
                                    │
                              ┌─────┴─────┐
                              ▼           ▼
                          SUCCESS      FAILED
                              │           │
                              ▼           ▼
                        FTC Request   Send Failure
                              │        Callback
                              ▼           │
                        Wait Callback     ▼
                              │          END
                        ┌─────┴─────┐
                        ▼           ▼
                    SUCCESS      FAILED
                        │           │
                        ▼           ▼
                  Send Success   Trigger
                   Callback     Reversal
                        │           │
                        ▼           ▼
                       END         END
```

## Field Transformations

Available transformations for field mappings:

| Transform | Description | Example |
|-----------|-------------|---------|
| `formatAmount` | Format amount to 12-digit string | `100` → `000000010000` |
| `formatDateTime` | Format timestamp to YYMMDDHHMMSS | → `250128143022` |
| `uppercase` | Convert to uppercase | `hello` → `HELLO` |
| `lowercase` | Convert to lowercase | `HELLO` → `hello` |
| `trim` | Remove whitespace | ` hello ` → `hello` |
| `padStart` | Pad string at start | Config: `{ length: 10, char: '0' }` |
| `padEnd` | Pad string at end | Config: `{ length: 10, char: '0' }` |

## TSQ (Transaction Status Query)

TSQ is automatically triggered for indeterminate responses:

**Trigger Codes:** 909, 912, null, 990, 9**, 108

**Retry Logic:**
- Wait 5 minutes after initial response
- Retry up to 3 times at 5-minute intervals

**Response Handling:**
| ActionCode | ApprovalCode | Result |
|------------|--------------|--------|
| 000 | (valid) | Success |
| 381 | - | Retry, fail after 3 |
| 999 | - | Validation error |
| 000 | 990 | Pending, manual check |
| 000 | 381 | Not found |
| Other | - | Fail transaction |

## Database Schema

Key tables:
- `flows` - Flow definitions
- `flow_steps` - Steps within flows
- `step_transitions` - Transitions between steps
- `field_mappings` - Field transformation mappings
- `flow_instances` - Running flow instances
- `step_executions` - Individual step executions
- `expected_callbacks` - Callbacks to wait for
- `received_callbacks` - Incoming callbacks
- `tsq_requests` - TSQ requests and status
- `reversal_requests` - Reversal records
- `process_logs` - Detailed process logs
- `event_logs` - Event history

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3002 |
| `DB_HOST` | PostgreSQL host | localhost |
| `DB_NAME` | Database name | orchestrator_db |
| `BFS_BASE_URL` | BFS service URL | http://localhost:3001 |
| `GIP_BASE_URL` | GIP API URL | http://localhost:4001 |
| `TSQ_RETRY_INTERVAL_MS` | TSQ retry interval | 300000 (5 min) |
| `TSQ_MAX_RETRIES` | Max TSQ retries | 3 |
| `CALLBACK_TIMEOUT_MS` | Callback wait timeout | 300000 (5 min) |

## Background Jobs

The orchestrator runs several background jobs:

| Job | Interval | Description |
|-----|----------|-------------|
| Flow Executor | 5s | Process pending flow instances |
| Callback Matcher | 10s | Match incoming callbacks |
| TSQ Scheduler | 60s | Process pending TSQ requests |
| Reversal Processor | 30s | Process pending reversals |

## License

MIT
