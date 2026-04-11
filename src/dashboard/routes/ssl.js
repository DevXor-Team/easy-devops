import express from 'express';
import SslController from '../controllers/sslController.js';

const router = express.Router();
const controller = new SslController();

router.post('/create', (req, res, next) => controller.create(req, res, next));
router.post('/create-confirm', (req, res, next) => controller.createConfirm(req, res, next));
router.post('/create-cancel', (req, res, next) => controller.createCancel(req, res, next));
router.get('/', (req, res, next) => controller.list(req, res, next));
router.post('/renew/:domain', (req, res, next) => controller.renew(req, res, next));
router.post('/renew-all', (req, res, next) => controller.renewAll(req, res, next));

export default router;
