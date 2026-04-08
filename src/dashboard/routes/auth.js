import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { loadConfig } from '../../core/config.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts. Try again in 15 minutes.' },
});

router.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  const { dashboardPassword } = loadConfig();
  if (password === dashboardPassword) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Invalid password' });
  }
});

router.get('/auth', (req, res) => {
  if (req.session.authenticated === true) {
    res.json({ authenticated: true });
  } else {
    res.json({ authenticated: false });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

export default router;
