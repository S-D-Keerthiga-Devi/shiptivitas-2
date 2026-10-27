import express from 'express';
import Database from 'better-sqlite3';

const app = express();

app.use(express.json());

// Enable CORS for frontend requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/', (req, res) => {
  return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (Number.isNaN(priority)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid priority provided.',
      'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  }
}

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = db.prepare('select * from clients where status = ?').all(status);
    return res.status(200).send(clients);
  }
  const statement = db.prepare('select * from clients');
  const clients = statement.all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;
  let clients = db.prepare('select * from clients').all();
  const client = clients.find(client => client.id === id);

  /* ---------- Update code below ----------*/

  const validStatuses = ['backlog', 'in-progress', 'complete'];

  if (status !== undefined && status !== null) {
    if (!validStatuses.includes(status)) {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
  }

  if (priority !== undefined && priority !== null) {
    priority = parseInt(priority, 10);
    const { valid: priorityValid, messageObj: priorityMsg } = validatePriority(priority);
    if (!priorityValid) {
      return res.status(400).send(priorityMsg);
    }
  }

  const targetStatus = status || client.status;

  // Group clients by status and sort each group by priority ascending
  const groups = {
    'backlog': clients.filter(c => c.status === 'backlog').sort((a, b) => a.priority - b.priority),
    'in-progress': clients.filter(c => c.status === 'in-progress').sort((a, b) => a.priority - b.priority),
    'complete': clients.filter(c => c.status === 'complete').sort((a, b) => a.priority - b.priority),
  };

  // Remove client from their current status group
  groups[client.status] = groups[client.status].filter(c => c.id !== client.id);

  // Determine target priority
  let targetPriority;
  if (priority !== undefined && priority !== null) {
    targetPriority = priority;
  } else {
    if (targetStatus === client.status) {
      targetPriority = client.priority;
    } else {
      // If moving to different swimlane with no priority provided, insert as lowest priority (biggest number)
      targetPriority = groups[targetStatus].length + 1;
    }
  }

  // Clamp priority to valid range: 1 to (target group length + 1)
  const maxPriority = groups[targetStatus].length + 1;
  const finalPriority = Math.min(Math.max(1, targetPriority), maxPriority);

  // Insert client into target group at the specified priority (1-indexed -> 0-indexed)
  groups[targetStatus].splice(finalPriority - 1, 0, {
    ...client,
    status: targetStatus,
  });

  // Persist updated priorities and statuses to database in a transaction
  const updateStmt = db.prepare('UPDATE clients SET status = ?, priority = ? WHERE id = ?');
  const updateTransaction = db.transaction(() => {
    for (const st of validStatuses) {
      groups[st].forEach((c, index) => {
        updateStmt.run(st, index + 1, c.id);
      });
    }
  });
  updateTransaction();

  clients = db.prepare('select * from clients').all();

  return res.status(200).send(clients);
});

app.listen(3001);
console.log('app running on port ', 3001);
