import { loadConfig } from '../../core/config.js';

class AuthController {
  login(req, res) {
    const { password } = req.body;
    const { dashboardPassword } = loadConfig();
    if (password === dashboardPassword) {
      req.session.authenticated = true;
      res.json({ ok: true });
    } else {
      res.status(401).json({ ok: false, error: 'Invalid password' });
    }
  }

  check(req, res) {
    if (req.session.authenticated === true) {
      res.json({ authenticated: true });
    } else {
      res.json({ authenticated: false });
    }
  }

  logout(req, res) {
    req.session.destroy();
    res.json({ ok: true });
  }
}

export default AuthController;
