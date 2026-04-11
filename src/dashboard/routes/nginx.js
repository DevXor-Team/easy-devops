import express from 'express';
import NginxController from '../controllers/nginxController.js';

const router = express.Router();
const controller = new NginxController();

router.get('/status', (req, res, next) => controller.status(req, res, next));
router.post('/reload', (req, res, next) => controller.reload(req, res, next));
router.post('/restart', (req, res, next) => controller.restart(req, res, next));
router.post('/start', (req, res, next) => controller.start(req, res, next));
router.post('/stop', (req, res, next) => controller.stop(req, res, next));
router.post('/test', (req, res, next) => controller.test(req, res, next));
router.get('/configs', (req, res, next) => controller.listConfigs(req, res, next));
router.get('/config/:filename', (req, res, next) => controller.getConfig(req, res, next));
router.post('/config/:filename', (req, res, next) => controller.saveConfig(req, res, next));
router.get('/logs', (req, res, next) => controller.getLogs(req, res, next));

export default router;
