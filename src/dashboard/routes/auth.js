import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import AuthController from '../controllers/authController.js';

const router = Router();
const controller = new AuthController();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts. Try again in 15 minutes.' },
});

router.post('/login', loginLimiter, (req, res, next) => controller.login(req, res, next));
router.get('/auth', (req, res, next) => controller.check(req, res, next));
router.post('/logout', (req, res, next) => controller.logout(req, res, next));

export default router;
