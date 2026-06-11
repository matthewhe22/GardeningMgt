// Seed demo data: users for each role, properties with coordinates,
// a week of visits, tasks and a sample issue. Run: npm run seed
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount > 0) {
  console.log('Database already has users — seed skipped.');
  process.exit(0);
}

const hash = (p) => bcrypt.hashSync(p, 10);
const addUser = db.prepare('INSERT INTO users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)');
const admin = addUser.run('Alice Admin', 'admin@example.com', hash('admin1234'), 'admin', '021 000 001').lastInsertRowid;
const sup = addUser.run('Sam Supervisor', 'supervisor@example.com', hash('super1234'), 'supervisor', '021 000 002').lastInsertRowid;
const g1 = addUser.run('Gary Gardener', 'gary@example.com', hash('garden1234'), 'gardener', '021 000 003').lastInsertRowid;
const g2 = addUser.run('Gina Gardener', 'gina@example.com', hash('garden1234'), 'gardener', '021 000 004').lastInsertRowid;

const addProp = db.prepare(`
  INSERT INTO properties (name, address, contact_name, contact_phone, lat, lng)
  VALUES (?, ?, ?, ?, ?, ?)`);
const props = [
  ['Rosewood Villa', '12 Rosewood Ln', 'Mrs Chen', '021 111 111', -36.8485, 174.7633],
  ['Harbour View', '88 Marine Pde', 'Mr Patel', '021 222 222', -36.8302, 174.7460],
  ['Oak Estate', '5 Oak Dr', 'Ms Brown', '021 333 333', -36.8689, 174.7766],
  ['Sunny Acres', '301 Sunny Rd', 'Mr Lee', '021 444 444', -36.8910, 174.7440],
  ['The Glasshouse', '7 Fern Way', 'Dr Green', '021 555 555', -36.8551, 174.7285],
  ['Civic Gardens', '1 Civic Sq', 'Council', '09 300 0000', -36.8520, 174.7640],
];
const propIds = props.map((p) => addProp.run(...p).lastInsertRowid);

const addVisit = db.prepare(`
  INSERT INTO visits (property_id, gardener_id, scheduled_date, time_window, created_by)
  VALUES (?, ?, ?, ?, ?)`);
const today = new Date();
const day = (offset) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10);
const windows = ['08:00-10:00', '10:00-12:00', '13:00-15:00', '15:00-17:00'];

const visitIds = [];
for (let d = 0; d < 5; d++) {
  propIds.forEach((pid, i) => {
    const gardener = i % 2 === 0 ? g1 : g2;
    visitIds.push(addVisit.run(pid, gardener, day(d), windows[i % windows.length], sup).lastInsertRowid);
  });
}

const addTask = db.prepare(`
  INSERT INTO tasks (visit_id, assignee_id, title, description, created_by) VALUES (?, ?, ?, ?, ?)`);
const taskTitles = ['Mow lawns', 'Trim hedges', 'Weed flower beds', 'Water greenhouse', 'Clear leaves'];
visitIds.slice(0, 12).forEach((vid, i) => {
  addTask.run(vid, i % 2 === 0 ? g1 : g2, taskTitles[i % taskTitles.length], null, sup);
});

db.prepare(`
  INSERT INTO issues (title, description, property_id, priority, reported_by, assigned_to)
  VALUES (?, ?, ?, ?, ?, ?)`)
  .run('Broken irrigation line', 'Main line near the rose beds is leaking; lawn flooding.',
    propIds[0], 'high', g1, sup);

db.prepare(`INSERT INTO activity_log (user_id, action, entity_type, details) VALUES (?, 'system.seed', 'system', ?)`)
  .run(admin, 'Seeded demo data');

console.log('Seeded demo data. Sign-in accounts:');
console.log('  admin@example.com      / admin1234   (admin)');
console.log('  supervisor@example.com / super1234   (supervisor)');
console.log('  gary@example.com       / garden1234  (gardener)');
console.log('  gina@example.com       / garden1234  (gardener)');
