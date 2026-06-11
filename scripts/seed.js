// Seed demo data: users for each role, properties with coordinates,
// a week of visits, tasks and a sample issue.
// Run: DATABASE_URL=postgresql://... npm run seed
const bcrypt = require('bcryptjs');
const { pool, q, q1, ready } = require('../src/db');

async function main() {
  await ready();

  // ready() may have created the bootstrap admin; only skip when real data exists.
  const { c } = await q1('SELECT COUNT(*)::int AS c FROM properties');
  if (c > 0) {
    console.log('Database already has data — seed skipped.');
    return;
  }

  const hash = (p) => bcrypt.hashSync(p, 10);
  const addUser = async (name, email, pw, role, phone) =>
    (await q1(`
      INSERT INTO users (name, email, password_hash, role, phone) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [name, email, hash(pw), role, phone])).id;

  const admin = await addUser('Alice Admin', 'admin@example.com', 'admin1234', 'admin', '021 000 001');
  const sup = await addUser('Sam Supervisor', 'supervisor@example.com', 'super1234', 'supervisor', '021 000 002');
  const g1 = await addUser('Gary Gardener', 'gary@example.com', 'garden1234', 'gardener', '021 000 003');
  const g2 = await addUser('Gina Gardener', 'gina@example.com', 'garden1234', 'gardener', '021 000 004');

  const props = [
    ['Rosewood Villa', '12 Rosewood Ln', 'Mrs Chen', '021 111 111', -36.8485, 174.7633],
    ['Harbour View', '88 Marine Pde', 'Mr Patel', '021 222 222', -36.8302, 174.7460],
    ['Oak Estate', '5 Oak Dr', 'Ms Brown', '021 333 333', -36.8689, 174.7766],
    ['Sunny Acres', '301 Sunny Rd', 'Mr Lee', '021 444 444', -36.8910, 174.7440],
    ['The Glasshouse', '7 Fern Way', 'Dr Green', '021 555 555', -36.8551, 174.7285],
    ['Civic Gardens', '1 Civic Sq', 'Council', '09 300 0000', -36.8520, 174.7640],
  ];
  const propIds = [];
  for (const p of props) {
    propIds.push((await q1(`
      INSERT INTO properties (name, address, contact_name, contact_phone, lat, lng)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, p)).id);
  }

  const today = new Date();
  const day = (offset) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10);
  const windows = ['08:00-10:00', '10:00-12:00', '13:00-15:00', '15:00-17:00'];

  const visitIds = [];
  for (let d = 0; d < 5; d++) {
    for (let i = 0; i < propIds.length; i++) {
      const gardener = i % 2 === 0 ? g1 : g2;
      visitIds.push((await q1(`
        INSERT INTO visits (property_id, gardener_id, scheduled_date, time_window, created_by)
        VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [propIds[i], gardener, day(d), windows[i % windows.length], sup])).id);
    }
  }

  const taskTitles = ['Mow lawns', 'Trim hedges', 'Weed flower beds', 'Water greenhouse', 'Clear leaves'];
  for (let i = 0; i < Math.min(12, visitIds.length); i++) {
    await q(`
      INSERT INTO tasks (visit_id, assignee_id, title, created_by) VALUES ($1, $2, $3, $4)`,
      [visitIds[i], i % 2 === 0 ? g1 : g2, taskTitles[i % taskTitles.length], sup]);
  }

  await q(`
    INSERT INTO issues (title, description, property_id, priority, reported_by, assigned_to)
    VALUES ($1, $2, $3, 'high', $4, $5)`,
    ['Broken irrigation line', 'Main line near the rose beds is leaking; lawn flooding.',
      propIds[0], g1, sup]);

  await q(`INSERT INTO activity_log (user_id, action, entity_type, details) VALUES ($1, 'system.seed', 'system', 'Seeded demo data')`, [admin]);

  console.log('Seeded demo data. Sign-in accounts:');
  console.log('  admin@example.com      / admin1234   (admin)');
  console.log('  supervisor@example.com / super1234   (supervisor)');
  console.log('  gary@example.com       / garden1234  (gardener)');
  console.log('  gina@example.com       / garden1234  (gardener)');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
