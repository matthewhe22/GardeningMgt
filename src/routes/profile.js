const express = require('express');

const router = express.Router();

// Account page: who am I, plus an easy sign-out for shared field devices.
router.get('/', (req, res) => {
  res.render('profile', { title: 'My profile' });
});

module.exports = router;
