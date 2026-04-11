import {
  getStatus,
  reload,
  restart,
  start,
  stop,
  test,
  listConfigs,
  getConfig,
  saveConfig,
  getLogs,
  NginxNotFoundError,
  NginxConfigError,
  InvalidFilenameError,
} from '../lib/nginx-service.js';

class NginxController {
  handleError(err, res) {
    if (err instanceof NginxNotFoundError) {
      return res.status(503).json({ error: 'nginx not installed' });
    }
    if (err instanceof NginxConfigError) {
      return res.status(400).json({ success: false, output: err.output });
    }
    if (err instanceof InvalidFilenameError) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Config file not found' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }

  async status(req, res, next) {
    try {
      const status = await getStatus();
      res.json(status);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async reload(req, res, next) {
    try {
      const result = await reload();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async restart(req, res, next) {
    try {
      const result = await restart();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async start(req, res, next) {
    try {
      const result = await start();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async stop(req, res, next) {
    try {
      const result = await stop();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async test(req, res, next) {
    try {
      const result = await test();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async listConfigs(req, res, next) {
    try {
      const configs = await listConfigs();
      res.json(configs);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async getConfig(req, res, next) {
    try {
      const result = await getConfig(req.params.filename);
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async saveConfig(req, res, next) {
    try {
      if (typeof req.body.content !== 'string') {
        return res.status(400).json({ error: 'content must be a string' });
      }
      const result = await saveConfig(req.params.filename, req.body.content);
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async getLogs(req, res, next) {
    try {
      const result = await getLogs(100);
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }
}

export default NginxController;
