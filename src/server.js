const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');

const db = require('./db');
const { currentUser, requireLogin } = require('./auth');
const { startReminderScheduler } = require('./reminders');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.locals.uploadDir = UPLOAD_DIR;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));

// Expose user + unread notification count to all views.
app.use((req, res, next) => {
  res.locals.user = currentUser(req);
  res.locals.unreadCount = res.locals.user
    ? db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL')
        .get(res.locals.user.id).c
    : 0;
  res.locals.currentPath = req.path;
  next();
});

app.use('/', require('./routes/auth'));
app.use('/uploads', requireLogin, express.static(UPLOAD_DIR));
app.use('/', requireLogin, require('./routes/dashboard'));
app.use('/visits', requireLogin, require('./routes/visits'));
app.use('/tasks', requireLogin, require('./routes/tasks'));
app.use('/issues', requireLogin, require('./routes/issues'));
app.use('/photos', requireLogin, require('./routes/photos'));
app.use('/routes', requireLogin, require('./routes/routeplan'));
app.use('/invoices', requireLogin, require('./routes/invoices'));
app.use('/reports', requireLogin, require('./routes/reports'));
app.use('/notifications', requireLogin, require('./routes/notifications'));
app.use('/admin', requireLogin, require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
});
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong.' });
});

if (require.main === module) {
  startReminderScheduler();
  app.listen(PORT, () => console.log(`GardeningMgt running on http://localhost:${PORT}`));
}

module.exports = app;
